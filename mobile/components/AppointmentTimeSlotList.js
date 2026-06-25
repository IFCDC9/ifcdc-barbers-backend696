import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

/**
 * Shows all schedule slots — available times are selectable; booked/unavailable are grayed out.
 *
 * @param {{ slots?: { time: string, available?: boolean, reason?: string }[], value: string|null, onSelect: (time: string) => void, disabled?: boolean }} props
 */
export default function AppointmentTimeSlotList({ slots = [], value, onSelect, disabled = false }) {
  const { t } = useTranslation();

  if (!slots.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{t('booking.selectTime')}</Text>
      <View style={styles.grid}>
        {slots.map((slot) => {
          const time = String(slot?.time || '').trim();
          if (!time) return null;
          const available = slot?.available !== false;
          const selected = value === time;
          const reason = slot?.reason || (available ? null : 'booked');
          const reasonLabel =
            reason === 'booked'
              ? t('booking.slotBooked', { defaultValue: 'Booked' })
              : reason === 'unavailable'
                ? t('booking.slotUnavailable', { defaultValue: 'Unavailable' })
                : null;

          return (
            <Pressable
              key={time}
              disabled={disabled || !available}
              onPress={() => onSelect(time)}
              style={({ pressed }) => [
                styles.chip,
                selected && styles.chipSelected,
                !available && styles.chipDisabled,
                pressed && available && !disabled && styles.chipPressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled: !available || disabled, selected }}
            >
              <Text style={[styles.chipTime, selected && styles.chipTimeSelected, !available && styles.chipTimeDisabled]}>
                {time}
              </Text>
              {!available && reasonLabel ? (
                <Text style={styles.chipReason}>{reasonLabel}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
    marginBottom: 12,
  },
  label: {
    color: '#FFD700',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    minWidth: '30%',
    flexGrow: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(245,200,66,0.35)',
    backgroundColor: '#111',
    alignItems: 'center',
  },
  chipSelected: {
    borderColor: '#FFD700',
    backgroundColor: 'rgba(245,200,66,0.15)',
  },
  chipDisabled: {
    opacity: 0.45,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#1a1a1a',
  },
  chipPressed: {
    backgroundColor: 'rgba(245,200,66,0.1)',
  },
  chipTime: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  chipTimeSelected: {
    color: '#FFD700',
  },
  chipTimeDisabled: {
    color: 'rgba(255,255,255,0.55)',
  },
  chipReason: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    marginTop: 2,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
});
