import React, { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '@/context/AppContext';
import { BrandMark } from '@/components/ui';

function AppNavigator() {
  const { colors, isDark, currentUser, authLoading } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (authLoading) return;

    const firstSegment = segments[0] as string | undefined;
    const isAuthRoute = firstSegment === 'auth' || firstSegment === 'login';

    if (!currentUser && !isAuthRoute) {
      // Compulsory authentication: user cannot enter app without logging in
      router.replace('/auth');
    } else if (currentUser && isAuthRoute) {
      // Already logged in: redirect to dashboard
      router.replace('/(tabs)');
    }
  }, [currentUser, authLoading, segments]);

  if (authLoading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <BrandMark size={64} />
        <ActivityIndicator size="large" color={colors.primary} />
        <Text
          style={{
            color: colors.muted,
            fontSize: 13,
            fontWeight: '700',
            letterSpacing: 0.4,
          }}
        >
          Securing DhwaniPay Soundbox...
        </Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        {/* Authentication Routes (Compulsory Entry Point) */}
        <Stack.Screen name="auth" options={{ gestureEnabled: false }} />
        <Stack.Screen name="login" options={{ gestureEnabled: false }} />

        {/* Protected App Routes */}
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="language" />
        <Stack.Screen name="setup" />
        <Stack.Screen name="sources" />
        <Stack.Screen name="permission-guide" />
        <Stack.Screen name="voice-test" />
        <Stack.Screen name="health" />
        <Stack.Screen name="recovery" />
        <Stack.Screen name="announcement-settings" />
        <Stack.Screen name="accessibility" />
        <Stack.Screen name="privacy" />
        <Stack.Screen name="help" />
        <Stack.Screen name="demo" />
        <Stack.Screen name="collect" />
        <Stack.Screen name="merchant-profile" />
        <Stack.Screen name="qr-vault" />
        <Stack.Screen name="gateway-settings" />
        <Stack.Screen name="event/[id]" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <AppNavigator />
      </AppProvider>
    </SafeAreaProvider>
  );
}
