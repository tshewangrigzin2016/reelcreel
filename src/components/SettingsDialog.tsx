import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Loading03Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import type {
  BinaryInfo,
  CookiesInfo,
  CookiesTestResult,
  HealthInfo,
  Settings,
} from "@shared/types";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Separator, Switch } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: Settings | null;
  health: HealthInfo | null;
  onSaved: (s: Settings) => void;
}

const TEMPLATE_VARS = [
  "%(title)s",
  "%(id)s",
  "%(uploader)s",
  "%(playlist_index)s",
  "%(resolution)s",
  "%(ext)s",
];

function previewTemplate(template: string): string {
  const sample: Record<string, string> = {
    "%(title)s": "Never Gonna Give You Up",
    "%(id)s": "dQw4w9WgXcQ",
    "%(uploader)s": "Rick Astley",
    "%(playlist_index)s": "01",
    "%(resolution)s": "1080p",
    "%(ext)s": "mp4",
  };
  let out = template;
  for (const [k, v] of Object.entries(sample)) out = out.split(k).join(v);
  return out;
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  health,
  onSaved,
}: Props) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<
    Record<string, { ok: boolean; version?: string } | null>
  >({});
  const [cookiesInfo, setCookiesInfo] = useState<CookiesInfo | null>(null);
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const [cookiesError, setCookiesError] = useState<string | null>(null);
  const [cookiesResult, setCookiesResult] =
    useState<CookiesTestResult | null>(null);

  useEffect(() => {
    if (open) setForm(settings);
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCookiesResult(null);
    setCookiesError(null);
    api
      .cookiesInfo()
      .then((info) => {
        if (!cancelled) setCookiesInfo(info);
      })
      .catch(() => {
        if (!cancelled) setCookiesInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!form) return null;
  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });

  const uploadCookies = async (file: File | undefined) => {
    if (!file) return;
    setCookiesBusy(true);
    setCookiesError(null);
    setCookiesResult(null);
    try {
      const res = await api.uploadCookies(await file.text());
      setCookiesInfo(res.info);
      setForm((current) =>
        current ? { ...current, cookiesPath: res.settings.cookiesPath } : current,
      );
      onSaved(res.settings);
    } catch (error) {
      setCookiesError(
        error instanceof Error ? error.message : "The cookies file was not accepted.",
      );
    } finally {
      setCookiesBusy(false);
    }
  };

  const removeCookies = async () => {
    setCookiesBusy(true);
    setCookiesError(null);
    setCookiesResult(null);
    try {
      const res = await api.clearCookies();
      setCookiesInfo(res.info);
      setForm((current) =>
        current ? { ...current, cookiesPath: undefined } : current,
      );
      onSaved(res.settings);
    } catch (error) {
      setCookiesError(
        error instanceof Error ? error.message : "Cookies could not be removed.",
      );
    } finally {
      setCookiesBusy(false);
    }
  };

  const testCookies = async () => {
    setCookiesBusy(true);
    setCookiesError(null);
    setCookiesResult(null);
    try {
      setCookiesResult(await api.testCookies());
    } catch (error) {
      setCookiesError(
        error instanceof Error ? error.message : "The cookies could not be tested.",
      );
    } finally {
      setCookiesBusy(false);
    }
  };

  const testBinary = async (name: "yt-dlp" | "ffmpeg") => {
    setTest((t) => ({ ...t, [name]: null }));
    const path = name === "ffmpeg" ? form.ffmpegPath : form.ytdlpPath;
    try {
      const res = await api.testBinary(name, path);
      setTest((t) => ({
        ...t,
        [name]: { ok: res.ok, version: res.info?.version },
      }));
    } catch {
      setTest((t) => ({ ...t, [name]: { ok: false } }));
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.saveSettings({
        ...form,
        ytdlpPath: form.ytdlpPath || null,
        ffmpegPath: form.ffmpegPath || null,
        runtimePath: form.runtimePath || null,
        cookiesPath: form.cookiesPath || null,
      });
      onSaved(next);
      onOpenChange(false);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Settings could not be saved. Your edits are preserved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" className="max-h-[85vh] overflow-y-auto">
        <div className="space-y-5">
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          <section className="space-y-3">
            <h3 className="micro">Binaries</h3>
            <p className="text-xs text-muted-foreground">
              Leave blank to auto-detect. Every candidate on PATH is probed with{" "}
              <code className="text-foreground">--version</code> and the first
              one that works wins, so Chocolatey shims going stale won't break
              the app.
            </p>

            {health ? (
              <div className="space-y-1.5 rounded-lg bg-secondary/50 p-3 text-xs">
                <BinaryRow label="yt-dlp" info={health.ytdlp} />
                <BinaryRow label="ffmpeg" info={health.ffmpeg} />
                <BinaryRow
                  label="JavaScript runtime"
                  info={health.runtime ?? health.node}
                />
                <BinaryRow label="ffprobe" info={health.ffprobe ?? null} />
                <p>{health.ejs?.detail}</p>
              </div>
            ) : null}

            <Field label="yt-dlp path (override)">
              <div className="flex gap-2">
                <Input
                  value={form.ytdlpPath ?? ""}
                  placeholder="auto-detect"
                  onChange={(e) =>
                    set({ ytdlpPath: e.target.value || undefined })
                  }
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => testBinary("yt-dlp")}
                >
                  Test
                </Button>
              </div>
              {test["yt-dlp"] ? (
                <TestResult
                  ok={test["yt-dlp"]!.ok}
                  version={test["yt-dlp"]!.version}
                />
              ) : null}
            </Field>

            <Field label="ffmpeg path (override)">
              <div className="flex gap-2">
                <Input
                  value={form.ffmpegPath ?? ""}
                  placeholder="auto-detect"
                  onChange={(e) =>
                    set({ ffmpegPath: e.target.value || undefined })
                  }
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => testBinary("ffmpeg")}
                >
                  Test
                </Button>
              </div>
              {test["ffmpeg"] ? (
                <TestResult
                  ok={test["ffmpeg"]!.ok}
                  version={test["ffmpeg"]!.version}
                />
              ) : null}
            </Field>
          </section>

          <section className="space-y-3">
            <Field label="JavaScript runtime">
              <select
                className="rounded border border-border bg-field p-2 text-sm"
                value={form.jsRuntime ?? "node"}
                onChange={(e) =>
                  set({ jsRuntime: e.target.value as "node" | "deno" })
                }
              >
                <option value="node">Node</option>
                <option value="deno">Deno</option>
              </select>
            </Field>
            <Field label="Runtime path override">
              <Input
                value={form.runtimePath ?? ""}
                onChange={(e) =>
                  set({ runtimePath: e.target.value || undefined })
                }
                placeholder="auto-detect"
              />
            </Field>
            <Field
              label="YouTube cookies"
              hint="YouTube treats a server's datacenter IP as a bot and asks it to sign in. Export a Netscape cookies.txt from a browser signed in to youtube.com, then upload it here. The file stays on the server with owner-only permissions; cookie values are never sent back to this page."
            >
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={form.cookiesPath ?? ""}
                    onChange={(e) =>
                      set({ cookiesPath: e.target.value || undefined })
                    }
                    placeholder="No cookies file (upload below, or type a local path)"
                  />
                  {form.cookiesPath ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={removeCookies}
                      disabled={cookiesBusy}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-border bg-transparent px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-secondary hover:text-foreground">
                    <input
                      type="file"
                      accept=".txt,text/plain"
                      className="hidden"
                      disabled={cookiesBusy}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        void uploadCookies(file);
                      }}
                    />
                    {cookiesBusy ? "Working…" : "Upload cookies.txt"}
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={testCookies}
                    disabled={cookiesBusy}
                  >
                    Test against YouTube
                  </Button>
                </div>
                {cookiesInfo?.configured ? (
                  <p className="text-[11px] text-muted-foreground">
                    {cookiesInfo.entries} cookie rows ({cookiesInfo.youtubeEntries}{" "}
                    YouTube/Google)
                    {cookiesInfo.updatedAt
                      ? ` · updated ${new Date(cookiesInfo.updatedAt).toLocaleString()}`
                      : ""}
                    {cookiesInfo.error ? (
                      <span className="text-destructive">
                        {" "}· {cookiesInfo.error}
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No cookies file configured. Downloads from a datacenter IP
                    usually fail with “Sign in to confirm you’re not a bot”.
                  </p>
                )}
                {cookiesError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {cookiesError}
                  </p>
                ) : null}
                {cookiesResult ? (
                  <p
                    className={`text-xs ${
                      cookiesResult.ok
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-destructive"
                    }`}
                  >
                    {cookiesResult.ok
                      ? `Working — YouTube answered without a sign-in wall (${cookiesResult.detail}).`
                      : cookiesResult.signInRequired
                        ? `YouTube still asks for a sign-in: ${cookiesResult.detail}`
                        : `Test failed: ${cookiesResult.detail}`}
                  </p>
                ) : null}
              </div>
            </Field>
            <Field
              label="Heavy conversions at once"
              hint="Only applies to FFmpeg remux/re-encode jobs — re-using a file you already have. Downloads are governed by Concurrent downloads, and encode the media they transfer."
            >
              <Input
                type="number"
                min={1}
                max={4}
                value={form.conversionConcurrency ?? 1}
                onChange={(e) =>
                  set({ conversionConcurrency: Number(e.target.value) })
                }
              />
            </Field>
          </section>
          <Separator />

          <section className="space-y-3">
            <h3 className="micro">Delivery</h3>
            <p className="text-xs text-muted-foreground">
              {form.deliveryMode === "browser"
                ? "Finished files are sent straight to the browser that asked for them and deleted from the server as soon as the transfer completes."
                : "Finished files are kept in the download folder below. This is the behaviour of a local install."}
            </p>
            <Toggle
              id="browser-delivery"
              label="Send files to the browser instead of keeping them here"
              hint="Turn this on when hosting on a server. Nothing is retained, so skipping and converting existing files stop applying."
              checked={form.deliveryMode === "browser"}
              onChange={(v) =>
                set({ deliveryMode: v ? "browser" : "server" })
              }
            />
            {form.deliveryMode === "browser" ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="Delete undelivered after (minutes)"
                    hint="Covers a closed tab that never asks for the file."
                  >
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      value={form.deliveryTtlMinutes ?? 15}
                      onChange={(e) =>
                        set({
                          deliveryTtlMinutes: Number(e.target.value) || 15,
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="Tolerate failed attempts"
                    hint="The file is deleted once this many transfers fail."
                  >
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={form.deliveryMaxAttempts ?? 3}
                      onChange={(e) =>
                        set({
                          deliveryMaxAttempts: Number(e.target.value) || 3,
                        })
                      }
                    />
                  </Field>
                </div>
                <Field
                  label="Temporary storage limit (MB)"
                  hint="When waiting files exceed this, the oldest is discarded."
                >
                  <Input
                    type="number"
                    min={1}
                    max={65536}
                    value={form.tempCapMb ?? 2048}
                    onChange={(e) =>
                      set({ tempCapMb: Number(e.target.value) || 2048 })
                    }
                  />
                </Field>
                <Field
                  label="Temporary folder"
                  hint="Where finished files wait. Nothing here is meant to survive."
                >
                  <p
                    className="field-box truncate text-muted-foreground"
                    title={form.tempDir}
                  >
                    {form.tempDir}
                  </p>
                </Field>
              </>
            ) : null}
          </section>
          <Separator />

          <section className="space-y-3">
            <h3 className="micro">Output</h3>
            {/* The download folder is a server-side path, so it means nothing
                when the file goes to the visitor's device. Hidden rather than
                disabled: an input that silently does nothing is worse. */}
            {form.deliveryMode === "browser" ? null : (
              <Field label="Download folder">
                <Input
                  value={form.outputDir}
                  onChange={(e) => set({ outputDir: e.target.value })}
                />
              </Field>
            )}
            <Field
              label="Filename template"
              hint={`Preview: ${previewTemplate(form.outputTemplate)}`}
            >
              <Input
                value={form.outputTemplate}
                onChange={(e) => set({ outputTemplate: e.target.value })}
              />
            </Field>
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() =>
                    set({ outputTemplate: `${form.outputTemplate}${v}` })
                  }
                  className="cursor-pointer rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                >
                  {v}
                </button>
              ))}
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="micro">Re-downloads</h3>
            {/* Both toggles compare a request against a file already on disk.
                In browser mode nothing is retained, so every request fetches
                fresh and these would never fire. */}
            {form.deliveryMode === "browser" ? (
              <p className="text-xs text-muted-foreground">
                Not applicable while files are sent to the browser: nothing is
                kept to compare against, so every download fetches fresh.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Before each download the app asks the site what it would fetch
                  and compares that against what is already on disk. A download
                  is only skipped when <em>every</em> attribute still matches —
                  title, format, resolution, codecs, bitrates, duration and file
                  size.
                </p>

                <Toggle
                  id="skip-existing"
                  label="Skip files I already have"
                  hint="A video downloaded at 1080p is fetched again once 4K appears."
                  checked={form.skipExisting !== false}
                  onChange={(v) => set({ skipExisting: v })}
                />

                <Toggle
                  id="convert-instead"
                  label="Convert instead of re-downloading"
                  hint="When only the container or codec differs, remux the copy with ffmpeg. Never used when re-using would lose quality, or drop subtitles, cover art, chapters or cuts."
                  checked={form.convertInstead !== false}
                  onChange={(v) => set({ convertInstead: v })}
                />
              </>
            )}
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="micro">Limits</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Playlist cap" hint="Mixes enumerate forever">
                <Input
                  type="number"
                  min={1}
                  max={5000}
                  value={form.playlistCap}
                  onChange={(e) =>
                    set({ playlistCap: Number(e.target.value) || 200 })
                  }
                />
              </Field>
              <Field label="Concurrent downloads">
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={form.downloadConcurrency}
                  onChange={(e) =>
                    set({ downloadConcurrency: Number(e.target.value) || 3 })
                  }
                />
              </Field>
              <Field label="Concurrent probes">
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={form.probeConcurrency}
                  onChange={(e) =>
                    set({ probeConcurrency: Number(e.target.value) || 4 })
                  }
                />
              </Field>
            </div>
          </section>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  className="h-4 w-4 animate-spin"
                />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={id} className="text-xs cursor-pointer">
          {label}
        </label>
        {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function BinaryRow({
  label,
  info,
}: {
  label: string;
  info: BinaryInfo | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      {info ? (
        <>
          <HugeiconsIcon
            icon={Tick01Icon}
            className="h-3 w-3 shrink-0 text-emerald-400"
          />
          <span className="truncate font-mono text-[11px]">{info.version}</span>
          <span
            className="truncate text-[11px] text-muted-foreground"
            title={info.path}
          >
            {info.path}
          </span>
        </>
      ) : (
        <>
          <HugeiconsIcon
            icon={Cancel01Icon}
            className="h-3 w-3 shrink-0 text-destructive"
          />
          <span className="text-[11px] text-destructive">not found</span>
        </>
      )}
    </div>
  );
}

function TestResult({ ok, version }: { ok: boolean; version?: string }) {
  return (
    <p
      className={`text-xs ${ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}
    >
      {ok
        ? `Working — ${version ?? "unknown version"}`
        : "No working binary at that path"}
    </p>
  );
}
