import React from "react";
import { SUPPORTED_LANGUAGES } from "../lib/languages.js";

/**
 * Scalable language dropdown — options from SUPPORTED_LANGUAGES registry.
 */
export default function LanguageDropdown({
  value,
  onChange,
  disabled = false,
  label,
  hint,
  id = "language-select",
}) {
  const selected =
    SUPPORTED_LANGUAGES.find((l) => l.code === value) ?? SUPPORTED_LANGUAGES[0];

  return (
    <label style={{ display: "grid", gap: 6, width: "100%" }}>
      {label ? (
        <span style={{ fontSize: 12, color: "#d4af37", fontWeight: 800, letterSpacing: 0.6 }}>
          {label}
        </span>
      ) : null}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid rgba(245,200,66,0.35)",
          background: "rgba(255,255,255,0.04)",
          color: "#f5f5f5",
          fontSize: 15,
          fontWeight: 600,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName} ({lang.englishName})
          </option>
        ))}
      </select>
      {hint ? <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{hint}</span> : null}
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
        Selected: {selected.nativeName}
      </span>
    </label>
  );
}
