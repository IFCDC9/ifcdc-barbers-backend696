import React, { useMemo, useState } from "react";
import { getPickerLanguages } from "../lib/languages.js";

/**
 * Searchable Language dropdown — English name + native name, no flags.
 * Options gated by VITE_MULTI_LANGUAGE_DROPDOWN_V2.
 */
export default function LanguageDropdown({
  value,
  onChange,
  disabled = false,
  label = "Language",
  hint,
  id = "language-select",
}) {
  const options = getPickerLanguages();
  const [query, setQuery] = useState("");
  const selected = options.find((l) => l.code === value) || options[0] || { code: "en", nativeName: "English", englishName: "English" };

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

  const dir = selected?.rtl ? "rtl" : "ltr";

  return (
    <label style={{ display: "grid", gap: 6, width: "100%" }} dir={dir}>
      {label ? (
        <span style={{ fontSize: 12, color: "#d4af37", fontWeight: 800, letterSpacing: 0.6 }}>
          {label}
        </span>
      ) : null}
      <input
        type="search"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search languages…"
        aria-label="Search languages"
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
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        size={Math.min(8, Math.max(4, filtered.length))}
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
            {lang.englishName} — {lang.nativeName}
          </option>
        ))}
      </select>
      {hint ? <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{hint}</span> : null}
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
        Selected: {selected.englishName} ({selected.nativeName})
      </span>
    </label>
  );
}
