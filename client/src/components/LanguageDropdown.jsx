import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPickerLanguages } from "../lib/languages.js";
import { setAppLanguage, currentAppLanguage } from "../i18n/index.js";

/**
 * Searchable language combobox — closed by default; closes on select, outside click, Escape.
 * Shows English name + native name. No flags.
 */
export default function LanguageDropdown({
  value,
  onChange,
  disabled = false,
  label,
  hint,
  id,
}) {
  const { t, i18n } = useTranslation();
  const reactId = useId();
  const rootId = id || `language-select-${reactId}`;
  const listboxId = `${rootId}-listbox`;
  const options = getPickerLanguages();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const searchRef = useRef(null);

  const controlled = value != null;
  const activeCode = controlled ? value : currentAppLanguage();
  const selected =
    options.find((l) => l.code === activeCode) ||
    options[0] || {
      code: "en",
      nativeName: "English",
      englishName: "English",
      rtl: false,
    };

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

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setQuery("");
    setOpen(true);
  }, [disabled]);

  const apply = useCallback(
    async (code) => {
      close();
      await setAppLanguage(code);
      if (typeof onChange === "function") onChange(code);
    },
    [close, onChange],
  );

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        close();
      }
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    const focusTimer = window.setTimeout(() => {
      searchRef.current?.focus?.();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div
      ref={rootRef}
      style={{ display: "grid", gap: 6, width: "100%", position: "relative" }}
      dir={selected?.rtl ? "rtl" : "ltr"}
      className="ifcdc-language-dropdown"
    >
      <span style={{ fontSize: 12, color: "#d4af37", fontWeight: 800, letterSpacing: 0.6 }}>
        {label || t("web.language.label", { defaultValue: "Language" })}
      </span>

      <button
        type="button"
        id={rootId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        style={{
          width: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid rgba(245,200,66,0.35)",
          background: "rgba(255,255,255,0.04)",
          color: "#f5f5f5",
          fontSize: 15,
          fontWeight: 600,
          cursor: disabled ? "not-allowed" : "pointer",
          textAlign: "start",
        }}
      >
        <span style={{ display: "grid", gap: 2 }}>
          <span>{selected.englishName}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.55)" }}>
            {selected.nativeName} · {selected.code}
          </span>
        </span>
        <span aria-hidden="true" style={{ color: "#d4af37", fontSize: 18, lineHeight: 1 }}>
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t("web.language.label", { defaultValue: "Language" })}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 40,
            marginTop: 6,
            borderRadius: 12,
            border: "1px solid rgba(245,200,66,0.35)",
            background: "#111",
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
            padding: 10,
            display: "grid",
            gap: 8,
          }}
        >
          <input
            ref={searchRef}
            type="search"
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
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

          <div
            style={{
              maxHeight: 260,
              overflowY: "auto",
              display: "grid",
              gap: 2,
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ padding: 12, color: "rgba(255,255,255,0.55)", textAlign: "center" }}>
                {t("common.notFound", { defaultValue: "No matches" })}
              </div>
            ) : (
              filtered.map((lang) => {
                const active = lang.code === selected.code;
                return (
                  <button
                    key={lang.code}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => void apply(lang.code)}
                    style={{
                      width: "100%",
                      textAlign: "start",
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "none",
                      cursor: "pointer",
                      background: active ? "rgba(245,200,66,0.12)" : "transparent",
                      color: "#f5f5f5",
                    }}
                  >
                    <div style={{ fontWeight: 700, color: active ? "#d4af37" : "#f5f5f5" }}>
                      {lang.englishName}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>
                      {lang.nativeName}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}

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
    </div>
  );
}
