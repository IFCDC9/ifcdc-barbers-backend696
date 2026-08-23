# Mobile i18n

## Boot
1. `import "./i18n"` initializes English synchronously.
2. `bootstrapI18n()` (called from `AppRoot`) restores AsyncStorage `@ifcdc/lang` or device locale.

## Feature flag
`EXPO_PUBLIC_MULTI_LANGUAGE_DROPDOWN_V2=1` expands the Language dropdown beyond English/Spanish.

## Add a language
1. Add meta in `languages.ts` / `ALL_LANGUAGES` (set `rtl: true` for RTL scripts such as Arabic / Hebrew).
2. Add `locales/{code}.json` mirroring `en.json` keys.
3. Import in `index.ts` `resources`.
4. Mirror the code in `featureFlag.ts`, `shared/multiLanguageFlag.js`, and `client/src/lib/languages.js`.

## Rules
- Never show raw translation keys.
- Fallback language is always `en`.
- Do not translate barber/shop/custom service names or user-generated content.
- Soft Yoga `direction` RTL is applied in `AppRoot` for `rtl: true` languages; native `I18nManager.forceRTL` stays gated.
