import express, { Request, Response } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import cors from 'cors';
import dotenv from 'dotenv';
import { createRazorpayQr, createCashfreeQr } from './gatewayService';

dotenv.config();

const PORT = process.env.PORT || 8080;

// Gateway Credentials
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_secret_key';

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || '';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || '';
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'sandbox';
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || 'test_cashfree_secret';

const app = express();

// Capture raw body for webhook cryptographic signature verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Keep track of connected merchant mobile apps
const clients = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket, req) => {
  clients.add(ws);
  console.log(`[WebSocket] Mobile client connected from ${req.socket.remoteAddress}. Total: ${clients.size}`);

  ws.send(
    JSON.stringify({
      type: 'CONNECTED',
      message: 'Connected to DhwaniPay Cloud Gateway Server',
      timestamp: new Date().toISOString(),
    })
  );

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Total active: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Error:', err);
    clients.delete(ws);
  });
});

/**
 * Broadcasts verified payment event to all connected DhwaniPay soundbox devices
 */
function broadcastPayment(payment: {
  amount: number;
  payerName?: string;
  source: string;
  utr?: string;
  orderId?: string;
}) {
  const packet = JSON.stringify({
    type: 'PAYMENT_RECEIVED',
    ...payment,
    timestamp: new Date().toISOString(),
  });

  console.log(`[Broadcast] Announcing payment: ₹${payment.amount} on ${payment.source} from ${payment.payerName || 'Anonymous'}`);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(packet);
    }
  }
}

// 1. Healthcheck & Active Connections
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    activeSoundboxConnections: clients.size,
    timestamp: new Date().toISOString(),
  });
});

// 2. Gateway Credentials Status
app.get('/api/gateway/credentials-status', (_req: Request, res: Response) => {
  res.json({
    razorpay: {
      configured: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
      hasWebhookSecret: Boolean(RAZORPAY_WEBHOOK_SECRET),
      keyIdPreview: RAZORPAY_KEY_ID ? `${RAZORPAY_KEY_ID.slice(0, 8)}...` : null,
    },
    cashfree: {
      configured: Boolean(CASHFREE_APP_ID && CASHFREE_SECRET_KEY),
      hasWebhookSecret: Boolean(CASHFREE_CLIENT_SECRET),
      environment: CASHFREE_ENV,
    },
    activeSoundboxes: clients.size,
  });
});

// 3. Create Dynamic Gateway UPI QR
// Called by the DhwaniPay mobile app when merchant wants a bank-settled QR
app.post('/api/gateway/create-qr', async (req: Request, res: Response) => {
  try {
    const { amount, customerName, notes, provider = 'razorpay' } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Valid amount is required.' });
    }

    let qrResult;
    if (provider === 'cashfree') {
      qrResult = await createCashfreeQr(
        { amount: Number(amount), customerName, notes, provider: 'cashfree' },
        CASHFREE_APP_ID,
        CASHFREE_SECRET_KEY,
        CASHFREE_ENV === 'production'
      );
    } else {
      qrResult = await createRazorpayQr(
        { amount: Number(amount), customerName, notes, provider: 'razorpay' },
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET
      );
    }

    res.json({
      success: true,
      data: qrResult,
    });
  } catch (error: any) {
    console.error('[Create QR Error]:', error);
    res.status(500).json({ error: error.message || 'Failed to create gateway QR' });
  }
});

// 4. Razorpay Payment Webhook
// Verified webhook listener for Razorpay UPI QR and Payment links
app.post('/api/webhooks/razorpay', (req: any, res: Response) => {
  const signature = req.headers['x-razorpay-signature'] as string;

  if (!signature) {
    return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
  }

  // Validate HMAC-SHA256 signature
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  if (signature !== expectedSignature) {
    console.warn('[Razorpay] Invalid webhook signature detected!');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body.event;
  console.log(`[Razorpay] Received verified event: ${event}`);

  if (event === 'payment.captured' || event === 'order.paid') {
    const paymentEntity = req.body.payload?.payment?.entity;
    if (paymentEntity) {
      const amountInRupees = paymentEntity.amount / 100; // Razorpay amounts are in paise
      const payerName = paymentEntity.notes?.customer_name || paymentEntity.email || undefined;
      const utr = paymentEntity.acquirer_data?.rrn || paymentEntity.id;

      broadcastPayment({
        amount: amountInRupees,
        payerName,
        source: 'Razorpay UPI',
        utr,
        orderId: paymentEntity.order_id,
      });
    }
  }

  res.status(200).json({ status: 'ok' });
});

// 5. Cashfree Payment Webhook
// Verified listener for Cashfree AutoCollect and Dynamic UPI QR
app.post('/api/webhooks/cashfree', (req: any, res: Response) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const timestamp = req.headers['x-webhook-timestamp'] as string;

  if (signature && timestamp) {
    const dataToSign = `${timestamp}${req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body)}`;
    const expectedSignature = crypto
      .createHmac('sha256', CASHFREE_CLIENT_SECRET)
      .update(dataToSign)
      .digest('base64');

    if (signature !== expectedSignature) {
      console.warn('[Cashfree] Signature mismatch!');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const body = req.body;
  if (body.type === 'PAYMENT_SUCCESS_WEBHOOK' || body.data?.payment?.payment_status === 'SUCCESS') {
    const payment = body.data?.payment;
    const customer = body.data?.customer_details;

    if (payment) {
      broadcastPayment({
        amount: Number(payment.payment_amount),
        payerName: customer?.customer_name,
        source: 'Cashfree UPI',
        utr: payment.bank_reference,
        orderId: body.data?.order?.order_id,
      });
    }
  }

  res.status(200).json({ status: 'ok' });
});

// 6. Simulate Verified Webhook Confirmation
// Creates a signed webhook payload and fires the internal broadcast,
// allowing merchants or developers to test end-to-end soundbox announcements
app.post('/api/gateway/simulate-webhook', (req: Request, res: Response) => {
  // Prevent unauthorized triggering in production without developer secret
  if (process.env.NODE_ENV === 'production' && !req.headers['x-admin-key']) {
    return res.status(403).json({ error: 'Simulation endpoints are disabled in production mode.' });
  }

  const { amount = 100, payerName = 'Sunita Verma', provider = 'razorpay' } = req.body;
  const source = provider === 'cashfree' ? 'Cashfree UPI' : 'Razorpay UPI';

  broadcastPayment({
    amount: Number(amount),
    payerName,
    source,
    utr: `BANK${Date.now().toString().slice(-8)}`,
  });

  res.json({
    success: true,
    message: `Simulated bank settlement for ₹${amount} announced to ${clients.size} connected soundbox apps.`,
  });
});

// 7. Manual Test Payment Endpoint
app.post('/api/test-payment', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production' && !req.headers['x-admin-key']) {
    return res.status(403).json({ error: 'Test payment endpoint is disabled in production mode.' });
  }

  const { amount = 50, payerName = 'Test Customer', source = 'UPI Test' } = req.body;

  broadcastPayment({
    amount: Number(amount),
    payerName,
    source,
    utr: `TEST${Date.now().toString().slice(-6)}`,
  });

  res.json({
    success: true,
    message: `Payment of ₹${amount} announced to ${clients.size} connected soundbox apps.`,
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` DhwaniPay Cloud Webhook Server running on port ${PORT}`);
  console.log(` WebSocket URL:       ws://localhost:${PORT}/ws`);
  console.log(` Create Dynamic QR:   POST http://localhost:${PORT}/api/gateway/create-qr`);
  console.log(` Razorpay Webhook:    POST http://localhost:${PORT}/api/webhooks/razorpay`);
  console.log(` Cashfree Webhook:    POST http://localhost:${PORT}/api/webhooks/cashfree`);
  console.log(` Simulate Settlement: POST http://localhost:${PORT}/api/gateway/simulate-webhook`);
  console.log(`=======================================================`);
});
