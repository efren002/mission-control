"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { catalogApi, type CustomProviderInput } from "@/features/catalog/api";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,38}$/;

interface InitialEntry {
  name: string;
  format: "openai" | "anthropic";
  base_url: string;
  model: string | null;
  max_tokens: number | null;
}

export function CustomProviderForm({
  mode,
  initial,
  token,
  onSaved,
  onCancel,
}: {
  mode: "create" | "update";
  initial?: InitialEntry;
  token: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [format, setFormat] = useState<"openai" | "anthropic">(initial?.format ?? "openai");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [maxTokens, setMaxTokens] = useState(initial?.max_tokens?.toString() ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const validate = (): CustomProviderInput | null => {
    if (!NAME_RE.test(name.trim())) {
      setError("Name must be 2-39 chars: letters, digits, underscore, or dash.");
      return null;
    }
    if (!/^https?:\/\/\S+$/i.test(baseUrl.trim())) {
      setError("Base URL must start with http:// or https://");
      return null;
    }
    if (mode === "create" && apiKey.trim().length === 0) {
      setError("API key is required.");
      return null;
    }
    const parsedMax = maxTokens.trim() === "" ? null : Number(maxTokens);
    if (parsedMax !== null && (!Number.isInteger(parsedMax) || parsedMax < 1)) {
      setError("Max tokens must be a positive whole number or left blank.");
      return null;
    }
    setError("");
    return {
      name: name.trim(),
      kind: "http",
      format,
      base_url: baseUrl.trim(),
      model: model.trim() || null,
      // null on update = keep existing key; the gateway treats a non-string api_key as "no change".
      api_key: apiKey.trim() === "" ? null : apiKey,
      max_tokens: parsedMax,
    };
  };

  const submit = async () => {
    const payload = validate();
    if (!payload) return;
    setBusy(true);
    try {
      if (mode === "create") {
        await catalogApi.createCustomProvider(token, payload);
      } else {
        await catalogApi.updateCustomProvider(token, initial?.name ?? payload.name, payload);
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save provider");
    } finally {
      setBusy(false);
    }
  };

  const heading = mode === "create" ? "Add custom provider" : `Edit ${initial?.name ?? "provider"}`;

  return (
    <div className="border border-signal/40 bg-white/[0.02] p-4">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-signal">{heading}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="openrouter" disabled={mode === "update"} className="field" />
        </Field>
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value as "openai" | "anthropic")} className="field">
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </Field>
        <Field label="Base URL" wide>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" className="field" />
        </Field>
        <Field label="Model override">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Provider default" className="field" />
        </Field>
        <Field label="Max tokens">
          <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" className="field" />
        </Field>
        <Field label="API key" wide>
          <div className="flex items-stretch gap-2">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type={showKey ? "text" : "password"}
              placeholder={mode === "update" ? "Leave blank to keep current key" : "sk-..."}
              autoComplete="off"
              className="field flex-1 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              className="inline-flex items-center justify-center border border-[#292824] px-3 text-dim hover:border-signal hover:text-signal"
            >
              {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-4 text-dim">
            Stored encrypted at rest; the gateway decrypts it to call the provider.
          </p>
        </Field>
      </div>
      {error && <p className="mt-3 text-[10px] text-orange-300">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button onClick={submit} disabled={busy} className="inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-50">
          {busy ? "Saving" : mode === "create" ? "Add provider" : "Save changes"}
        </button>
        <button onClick={onCancel} disabled={busy} className="inline-flex items-center gap-2 border border-[#292824] px-4 py-2 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block text-[10px] uppercase text-dim ${wide ? "sm:col-span-2" : ""}`}>
      {label}
      <div className="mt-2">{children}</div>
    </label>
  );
}
