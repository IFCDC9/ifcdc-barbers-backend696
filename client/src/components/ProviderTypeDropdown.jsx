import { PROVIDER_TYPES } from "../lib/providerTypes.js";

import React from "react";

export default function ProviderTypeDropdown({
  value,
  onChange,
  disabled = false,
  label = "Provider type",
  includeCustomer = false,
  includeAll = false,
}) {
  const options = [
    ...(includeAll ? [{ id: "", label: "All provider types" }] : []),
    ...(includeCustomer ? [{ id: "customer", label: "Customer" }] : []),
    ...PROVIDER_TYPES,
  ];

  return (
    <label style={{ display: "grid", gap: 6, width: "100%" }}>
      <span style={{ fontSize: 12, color: "#d4af37", fontWeight: 800 }}>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="auth-input"
        style={{ cursor: disabled ? "not-allowed" : "pointer" }}
      >
        {options.map((opt) => (
          <option key={opt.id || "all"} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
