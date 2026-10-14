import { Platform } from 'react-native';

export interface NativePaymentEvent {
  amount: number;
  source: string;
  payer: string;
  utr: string;
  announcedNatively?: boolean;
}

type PaymentCallback = (event: NativePaymentEvent) => void;
type Subscription = { remove: () => void };

const NOOP_SUBSCRIPTION: Subscription = { remove: () => {} };

/**
 * Subscribe to native Android payment notifications intercepted by
 * PaymentNotificationListenerService via the PaymentListener Expo module.
 *
 * Returns a subscription handle — call .remove() to unsubscribe.
 * No-ops gracefully on iOS, web, and Expo Go (where native modules are unavailable).
 */
export function addPaymentListener(callback: PaymentCallback): Subscription {
  if (Platform.OS !== 'android') {
    return NOOP_SUBSCRIPTION;
  }

  try {
    // Dynamic require to avoid crash on platforms where the native module isn't linked
    const ExpoModulesCore = require('expo-modules-core');
    const nativeModule = ExpoModulesCore.requireNativeModule('PaymentListener');
    const emitter = new ExpoModulesCore.EventEmitter(nativeModule);
    return emitter.addListener('onPaymentReceived', callback);
  } catch (e) {
    // Expected in Expo Go or when prebuild hasn't been run
    console.warn('[PaymentListener] Native module unavailable (run npx expo prebuild first):', e);
    return NOOP_SUBSCRIPTION;
  }
}

/**
 * Check if the Android user has granted DhwaniPay NotificationListener permission in system settings.
 */
export async function isPermissionGranted(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true; // Non-android platforms fallback gracefully
  }

  try {
    const ExpoModulesCore = require('expo-modules-core');
    const nativeModule = ExpoModulesCore.requireNativeModule('PaymentListener');
    return await nativeModule.isPermissionGranted();
  } catch {
    return false;
  }
}

/**
 * Open the Android system Notification Listener Access settings screen
 * so the merchant can toggle DhwaniPay on with a single tap.
 */
export async function openPermissionSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }

  try {
    const ExpoModulesCore = require('expo-modules-core');
    const nativeModule = ExpoModulesCore.requireNativeModule('PaymentListener');
    return await nativeModule.openPermissionSettings();
  } catch (e) {
    console.warn('[PaymentListener] Could not open notification listener settings:', e);
    return false;
  }
}

