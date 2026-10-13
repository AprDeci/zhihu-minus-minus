import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useRuntimeThemeColors } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';

export const CONTENT_ACTION_BAR_HEIGHT = 52;

export interface ContentActionBarProps {
  bottomInset: number;
  bottomOffset?: number;
  variant?: 'bar' | 'islands';
  leading?: ReactNode;
  trailing?: ReactNode;
  accessory?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  visible?: boolean;
  shrinkLeading?: boolean;
}

/** Preserve safe-area clearance, then raise the floating bar by 20. */
export function getContentActionBarBottom(
  bottomInset: number,
  bottomOffset = 0,
): number {
  return Math.max(bottomInset + bottomOffset, 12) + 12;
}

/** Common floating surface; supports unified bar (Variant A) or floating islands (Variant B). */
export function ContentActionBar({
  bottomInset,
  bottomOffset = 0,
  variant = 'bar',
  leading,
  trailing,
  accessory,
  children,
  style,
  visible = true,
  shrinkLeading = false,
}: ContentActionBarProps) {
  const colors = useRuntimeThemeColors();
  const colorScheme = useColorScheme();
  const bottom = getContentActionBarBottom(bottomInset, bottomOffset);

  if (variant === 'islands') {
    return (
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.container,
          styles.islandsContainer,
          {
            bottom,
            height: CONTENT_ACTION_BAR_HEIGHT,
            opacity: visible ? 1 : 0,
          },
          style,
        ]}
      >
        {leading ? (
          <View
            style={[
              styles.islandShadow,
              shrinkLeading && styles.shrinkableLeading,
              {
                backgroundColor: colors.contentOverlayStrong,
              },
              colorScheme === 'light' && {
                shadowColor: colors.shadow,
                ...styles.shadow,
              },
            ]}
          >
            <BlurView
              intensity={130}
              tint={colorScheme}
              style={[
                styles.surface,
                styles.islandLeading,
                {
                  height: CONTENT_ACTION_BAR_HEIGHT,
                  borderRadius: CONTENT_ACTION_BAR_HEIGHT / 2,
                  borderColor: colors.contentBorder,
                },
              ]}
            >
              {leading}
            </BlurView>
          </View>
        ) : null}

        <View style={styles.islandRightGroup}>
          {trailing ? (
            <View
              style={[
                styles.islandShadow,
                {
                  backgroundColor: colors.contentOverlayStrong,
                },
                colorScheme === 'light' && {
                  shadowColor: colors.shadow,
                  ...styles.shadow,
                },
              ]}
            >
              <BlurView
                intensity={130}
                tint={colorScheme}
                style={[
                  styles.surface,
                  styles.islandTrailing,
                  {
                    height: CONTENT_ACTION_BAR_HEIGHT,
                    borderRadius: CONTENT_ACTION_BAR_HEIGHT / 2,
                    borderColor: colors.contentBorder,
                  },
                ]}
              >
                {trailing}
              </BlurView>
            </View>
          ) : null}

          {accessory ? (
            <View
              style={[
                styles.islandShadow,
                styles.islandAccessoryContainer,
                {
                  backgroundColor: colors.contentOverlayStrong,
                },
                colorScheme === 'light' && {
                  shadowColor: colors.shadow,
                  ...styles.shadow,
                },
              ]}
            >
              <BlurView
                intensity={130}
                tint={colorScheme}
                style={[
                  styles.surface,
                  styles.islandAccessory,
                  {
                    width: CONTENT_ACTION_BAR_HEIGHT,
                    height: CONTENT_ACTION_BAR_HEIGHT,
                    borderRadius: CONTENT_ACTION_BAR_HEIGHT / 2,
                    borderColor: colors.contentBorder,
                  },
                ]}
              >
                {accessory}
              </BlurView>
            </View>
          ) : null}
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      style={[
        styles.container,
        {
          bottom,
          height: CONTENT_ACTION_BAR_HEIGHT,
          borderRadius: CONTENT_ACTION_BAR_HEIGHT / 2,
          opacity: visible ? 1 : 0,
        },
        colorScheme === 'light' && {
          shadowColor: colors.shadow,
          ...styles.shadow,
        },
        style,
      ]}
    >
      <BlurView
        intensity={130}
        tint={colorScheme}
        style={[
          styles.surface,
          {
            height: CONTENT_ACTION_BAR_HEIGHT,
            borderRadius: CONTENT_ACTION_BAR_HEIGHT / 2,
            backgroundColor: colors.contentOverlayStrong,
            borderColor: colors.contentBorder,
          },
        ]}
      >
        {leading || trailing || accessory ? (
          <View style={styles.barRow}>
            {leading ? (
              <View
                style={[
                  styles.leadingSlot,
                  shrinkLeading && styles.shrinkableLeading,
                ]}
              >
                {leading}
              </View>
            ) : null}
            <View style={styles.trailingSlot}>
              {trailing}
              {accessory ? (
                <View style={styles.accessorySlot}>{accessory}</View>
              ) : null}
            </View>
          </View>
        ) : (
          children
        )}
      </BlurView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 16, right: 16, zIndex: 1000 },
  surface: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  shadow: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 4,
  },
  barRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
  },
  leadingSlot: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  trailingSlot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
  },
  accessorySlot: {
    marginLeft: 8,
    backgroundColor: 'transparent',
  },
  islandsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'transparent',
  },
  islandShadow: {
    height: CONTENT_ACTION_BAR_HEIGHT,
    borderRadius: CONTENT_ACTION_BAR_HEIGHT / 2,
  },
  islandLeading: {
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shrinkableLeading: {
    flexShrink: 1,
    minWidth: 0,
  },
  islandRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  islandTrailing: {
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  islandAccessory: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  islandAccessoryContainer: {
    width: CONTENT_ACTION_BAR_HEIGHT,
    marginLeft: 8,
  },
});
