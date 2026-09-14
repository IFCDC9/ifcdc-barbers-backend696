/** Client-side catalog mirror of monetizationCatalog.js (no secrets). */
export function catalogPublicShape() {
  return {
    apple: {
      subscriptionGroup: "IFCDC Barbers Pro Plans",
      products: [
        { productId: "ifcdc.barbers.multilocation.monthly", planKey: "multilocation", listPriceUsd: 59.99 },
        { productId: "ifcdc.barbers.shop.monthly", planKey: "shop", listPriceUsd: 29.99 },
        { productId: "ifcdc.barbers.individual.monthly", planKey: "individual", listPriceUsd: 9.99 },
      ],
      promoPlaceholders: {
        individual: { priceUsd: 4.99 },
        shop: { priceUsd: 14.99 },
        multilocation: { priceUsd: 29.99 },
      },
    },
    google: {
      access: { productId: "ifcdc.barbers.access", listPriceUsd: 0.99 },
    },
  };
}
