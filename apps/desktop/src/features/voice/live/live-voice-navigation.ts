import {
  isSettingsDestinationHidden,
  resolveSettingsTab,
} from "../../../lib/settings-search";
import { useAppStore } from "../../../stores/app-store";

/**
 * Jump from a Live Voice surface to the card that owns its settings.
 *
 * Live Voice has no rail row of its own: the card renders inside General,
 * below Appearance, storage, network, and power. Landing on the merged page
 * without an anchor would leave the enable switch and provider binding two
 * screens further down, so navigation also seeds the card's heading as the
 * settings anchor, which the page scrolls to and flashes.
 */
export function openLiveVoiceSettings() {
  const store = useAppStore.getState();
  // Voice is a retired destination id: resolve it first so the visibility
  // check and the stored tab describe the page that actually renders.
  const destination = resolveSettingsTab("voice");
  const hidden = isSettingsDestinationHidden(
    destination,
    store.settings?.developerMode === true,
    import.meta.env.DEV,
  );
  // A hidden destination falls back to Models, which owns the provider accounts
  // and the account binding the card links to; that page carries no Live Voice
  // card, so it gets no anchor.
  store.setSettingsTab(hidden ? "agent" : destination);
  store.setSettingsAnchor(hidden ? null : "liveVoice.title");
  store.setPage("settings");
}
