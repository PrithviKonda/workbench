import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { ExternalLink } from "./ui/external-link";
import { Button } from "./ui/button";
import type { AppUpdateAvailableEvent, AppUpdateProgress } from "../../shared/types";

const RELEASES_URL = "https://github.com/PrithviKonda/workbench/releases/tag/v";

/**
 * App update banner: a small card in the corner when a new release is out. The update downloads
 * in the background as soon as it's found; "Update" installs it and reopens the app (if the
 * download is still running, it installs the moment it finishes).
 */
export function AppUpdateNotification() {
  const { t } = useTranslation(["dialogs", "common"]);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateAvailableEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  // Set once "Update" is pressed, so a download that finishes later installs right away
  const installWhenReady = useRef(false);

  useEffect(() => {
    const cleanups = [
      window.electronAPI.onAppUpdateAvailable((info) => {
        setUpdateInfo(info);
        setVisible(true);
        setDownloaded(false);
        setProgress(null);
        setError(null);
        setReadOnly(false);
      }),
      window.electronAPI.onAppUpdateDownloaded((info) => {
        setUpdateInfo((current) => current ?? { version: info.version, releaseNotes: info.releaseNotes, releaseDate: info.releaseDate });
        setVisible(true);
        setDownloaded(true);
        setProgress(null);
        if (installWhenReady.current) window.electronAPI.installAppUpdate();
      }),
      window.electronAPI.onAppUpdateProgress(setProgress),
      window.electronAPI.onAppUpdateError((updateError) => {
        setError(updateError.message);
        setUpdating(false);
        installWhenReady.current = false;
      }),
      window.electronAPI.onAppUpdateReadOnlyVolume(() => {
        setReadOnly(true);
        setUpdating(false);
        installWhenReady.current = false;
      }),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  const update = async () => {
    setError(null);
    setUpdating(true);
    if (downloaded) {
      window.electronAPI.installAppUpdate();
      return;
    }
    installWhenReady.current = true;
    // Starts the download if it isn't running yet (a running one is reused)
    const result = await window.electronAPI.downloadAppUpdate().catch(() => ({ success: false, error: undefined }));
    if (!result.success) {
      setError(result.error || t("dialogs:appUpdate.downloadError"));
      setUpdating(false);
      installWhenReady.current = false;
    }
  };

  const later = () => {
    setVisible(false);
    void window.electronAPI.snoozeAppUpdate().catch(() => undefined);
  };

  if (!updateInfo || !visible) return null;

  const status = readOnly
    ? t("dialogs:appUpdate.readOnlyVolumeDescription")
    : error
      ? error
      : updating && progress && !downloaded
        ? t("dialogs:appUpdate.downloadingPercent", { percent: Math.round(progress.percent) })
        : updating
          ? t("dialogs:appUpdate.restarting")
          : null;

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground">{t("dialogs:appUpdate.bannerTitle", { version: updateInfo.version })}</p>
          <p className={error || readOnly ? "mt-0.5 text-xs text-destructive" : "mt-0.5 text-xs text-muted-foreground"}>
            {status ?? (
              <ExternalLink href={`${RELEASES_URL}${updateInfo.version}`} className="text-xs">
                {t("dialogs:appUpdate.whatsNew")}
              </ExternalLink>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={later}
          aria-label={t("dialogs:appUpdate.remindMeLater")}
          className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-nav-hover hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2.5 flex justify-end">
        <Button size="sm" className="gap-1.5" onClick={() => void update()} disabled={updating || readOnly}>
          {updating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("dialogs:appUpdate.update")}
        </Button>
      </div>
    </div>
  );
}
