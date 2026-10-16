import * as SplashScreen from 'expo-splash-screen';
import { Stack } from 'expo-router';
import { AnimatedSplashOverlay } from '@/components/animated-icon';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)/login" />
        <Stack.Screen name="(assistant)/wallet" />
        <Stack.Screen name="(staff)/scanner" />
      </Stack>
      <AnimatedSplashOverlay />
    </>
  );
}
