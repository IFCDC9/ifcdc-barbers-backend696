const phoneNumber = import.meta.env.VITE_BUSINESS_PHONE || "+17327435048";

export const SYSTEM_CONFIG = {
  BUSINESS_PHONE: String(phoneNumber).trim(),
};
