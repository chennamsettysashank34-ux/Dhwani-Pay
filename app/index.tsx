import React from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useApp } from '@/context/AppContext';
import { BrandMark } from '@/components/ui';

/**
 * Root Entry Route (/) for DhwaniPay
 *
 * Provides deterministic initial routing without race conditions.
 * Declaratively redirects to /auth (if not logged in) or /(tabs) (if logged in)
 * as soon as auth initialization finishes.
 */
export default function RootIndex() {
  const { colors, currentUser, authLoading } = useApp();

  if (authLoading) {
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: colors.background,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
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
    );
  }

  if (currentUser) {
    return <Redirect href="/(tabs)" />;
  }

  return <Redirect href="/auth" />;
}
