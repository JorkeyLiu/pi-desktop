import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export function FastModelRow({
  settings,
  providers,
}: {
  settings: AppSettings | null;
  providers: ProviderPublic[];
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => providers.flatMap((provider) => {
    if (provider.enabled === false || !(provider.hasSecret || provider.hasOauth || provider.authKind === "none")) return [];
    const models = provider.models?.length ? provider.models : provider.defaultModelId ? [{ id: provider.defaultModelId }] : [];
    return models.filter((model) => model.id.trim()).map((model) => ({
      id: `${provider.id}\u0000${model.id}`,
      providerId: provider.id,
      modelId: model.id,
      label: `${provider.name} · ${model.id}`,
    }));
  }), [providers]);
  const selected = choices.find((choice) =>
    choice.providerId === settings?.fastModelProviderId && choice.modelId === settings?.fastModelId,
  );
  const options = [
    { id: "", label: t("settings.fastModelNone") },
    ...choices.map(({ id, label }) => ({ id, label })),
  ];
  const save = async (id: string) => {
    if (!settings || busy) return;
    const choice = choices.find((item) => item.id === id);
    const next: AppSettings = {
      ...settings,
      fastModelProviderId: choice?.providerId ?? null,
      fastModelId: choice?.modelId ?? null,
    };
    setBusy(true);
    try {
      await api.setSettings(next);
      useAppStore.setState({ settings: next });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-row model-default-row">
      <div className="settings-row-copy model-default-copy">
        <div className="settings-row-title model-default-label">{t("settings.fastModel")}</div>
        <div className="settings-row-detail model-default-value">{t("settings.fastModelDescription")}</div>
      </div>
      <SettingsMenuSelect
        className="model-image-selector"
        label={t("settings.fastModel")}
        value={selected?.id ?? ""}
        options={options}
        busy={busy}
        onChange={(id) => void save(id)}
      />
    </div>
  );
}
