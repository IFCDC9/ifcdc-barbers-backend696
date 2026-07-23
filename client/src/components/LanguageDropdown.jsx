import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPickerLanguages } from "../lib/languages.js";
import { setAppLanguage, currentAppLanguage } from "../i18n/index.js";

/**
 * Searchable Language dropdown — updates i18n immediately (no re-login).
 * Shows English name + native name. No flags.
 */
export default function LanguageDropdown({
  value,
  onChange,
  disabled = false,
  label,
  hint,
  id = "language-select",
}) {
  const { t, i18n } = useTranslation();
  const options = getPickerLanguages();
  const [query, setQuery] = useState("");
  const controlled = value != null;
  const activeCode = controlled ? value : currentAppLanguage();
  const selected =
    options.find((l) => l.code === activeCode) ||
    options[0] || { code: "en", nativeName: "English", englishName: "English", rtl: false };

  const filtered = useMemo(() => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (lang) =>
        lang.englishName.toLowerCase().includes(q) ||
        lang.nativeName.toLowerCase().includes(q) ||
        lang.code.toLowerCase().includes(q),
    );
  }, [options, query]);

  const apply = async (code) => {
    await setAppLanguage(code);
    if (typeof onChange === "function") onChange(code);
  };

  return (
    <label
      style={{ display: "grid", gap: 6, width: "100%" }}
      dir={selected?.rtl ? "rtl" : "ltr"}
      className="ifcdc-language-dropdown"
    >
      <span style={{ fontSize: 12, color: "#d4af37", fontWeight: 800, letterSpacing: 0.6 }}>
        {label || t("web.language.label", { defaultValue: "Language" })}
      </span>
      <input
        type="search"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("web.language.search", { defaultValue: "Search languages…" })}
        aria-label={t("web.language.search", { defaultValue: "Search languages…" })}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,0.16)",
          background: "#171717",
          color: "#fff",
        }}
      />
      <select
        id={id}
        value={selected.code}
        disabled={disabled}
        onChange={(e) => void apply(e.target.value)}
        size={Math.min(9, Math.max(4, filtered.length))}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid rgba(245,200,66,0.35)",
          background: "rgba(255,255,255,0.04)",
          color: "#f5f5f5",
          fontSize: 15,
          fontWeight: 600,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {filtered.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName} ({lang.englishName})
          </option>
        ))}
      </select>
      {hint ? <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{hint}</span> : null}
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
        {t("web.language.selected", {
          name: `${selected.englishName} — ${selected.nativeName}`,
          defaultValue: `Selected: ${selected.englishName}`,
        })}
      </span>
      <span className="sr-only" aria-live="polite">
        {i18n.language}
      </span>
    </label>
  );
}
