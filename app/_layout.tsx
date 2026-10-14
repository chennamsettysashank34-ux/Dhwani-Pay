import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '@/context/AppContext';
import { BrandMark } from '@/components/ui';

export { ErrorBoundary } from 'expo-router';

function AppNavigator() {
  const { colors, isDark, currentUser, authLoading } = useApp();
  const segments = useSegments();
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();

  useEffect(() => {
    // Prevent navigating before the root navigation container is mounted
    if (!rootNavigationState?.key || authLoading) return;

    const firstSegment = segments[0] as string | undefined;
    const isAuthRoute = firstSegment === 'auth' || firstSegment === 'login';

    if (!currentUser && !isAuthRoute && firstSegment !== undefined) {
      // Compulsory authentication: user cannot enter app without logging in
      router.replace('/auth');
    } else if (currentUser && isAuthRoute) {
      // Already logged in: redirect to dashboard
      router.replace('/(tabs)');
    }
  }, [currentUser, authLoading, segments, rootNavigationState?.key]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        {/* Entry Point */}
        <Stack.Screen name="index" options={{ headerShown: false }} />

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

      {authLoading && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: colors.background,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
              zIndex: 999,
            },
          ]}
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
      )}
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <AppNavigator />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
