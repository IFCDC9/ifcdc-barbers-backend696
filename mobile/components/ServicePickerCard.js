import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { apiFullUrl } from '../constants/config';

/**
 * Selectable service card for the booking flow.
 * @param {{ service: object, selected?: boolean, onPress: () => void }} props
 */
export default function ServicePickerCard({ service, selected = false, onPress }) {
  const { t } = useTranslation();
  const icon = service.icon || '✂️';
  const price = Number(service.price);
  const duration = Number(service.duration_minutes) || 30;
  const imageUri = service.image_url
    ? (String(service.image_url).startsWith('http') ? service.image_url : apiFullUrl(service.image_url))
    : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && styles.cardPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <View style={styles.iconWrap}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.serviceImage} />
        ) : (
          <Text style={styles.icon}>{icon}</Text>
        )}
      </View>
      <View style={styles.copy}>
        <Text style={styles.name}>{service.name}</Text>
        {service.description ? (
          <Text style={styles.description} numberOfLines={2}>
            {service.description}
          </Text>
        ) : null}
        <Text style={styles.meta}>
          ${Number.isFinite(price) ? price.toFixed(2) : '—'} · {duration} {t('services.minSuffix')}
        </Text>
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    marginBottom: 10,
    backgroundColor: '#111',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(245,200,66,0.2)',
  },
  cardSelected: {
    borderColor: 'rgba(245,200,66,0.55)',
    backgroundColor: 'rgba(245,200,66,0.08)',
  },
  cardPressed: {
    opacity: 0.92,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(245,200,66,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 22,
  },
  serviceImage: {
    width: 44,
    height: 44,
    borderRadius: 8,
    resizeMode: 'cover',
  },
  copy: {
    flex: 1,
    gap: 4,
  },
  name: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  description: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 18,
  },
  meta: {
    color: '#FFD700',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 2,
  },
  check: {
    color: '#FFD700',
    fontSize: 18,
    fontWeight: '800',
    marginLeft: 4,
  },
});
