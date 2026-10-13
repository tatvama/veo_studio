/**
 * Every preference of the Settings window, as data: its sections and the searchable items in each (the Settings
 * search and the command palette both read this).
 */
export interface SettingsSection { id: string; title: string; blurb: string }
export interface SettingsItem { section: string; id: string; label: string; keywords?: string }

export const SECTIONS: SettingsSection[] = [
  { id: "server", title: "Server and screens", blurb: "The studio server and where the screens come from" },
  { id: "library", title: "Library and naming", blurb: "Where projects live on this PC and how files are named" },
  { id: "rendering", title: "Rendering", blurb: "Encoders, proxies and the GPU engine" },
  { id: "ai-tools", title: "AI tools on this PC", blurb: "Real-ESRGAN, RIFE, Whisper and MediaPipe" },
  { id: "assistants", title: "AI assistants", blurb: "Assistants that can edit on this PC" },
  { id: "storage", title: "Storage", blurb: "Cache sizes and free space" },
  { id: "appearance", title: "Appearance", blurb: "Theme, accent, density, scale, motion and contrast" },
  { id: "notifications", title: "Notifications", blurb: "Which events notify you, and how" },
  { id: "shortcuts", title: "Shortcuts", blurb: "Keyboard shortcuts of the app and the editor" },
  { id: "updates", title: "Updates", blurb: "Check now, install on quit, release notes" },
  { id: "advanced", title: "Advanced", blurb: "Logs, graphics card, window behaviour and resets" },
];

export const ITEMS: SettingsItem[] = [
  { section: "server", id: "server-url", label: "Studio server address", keywords: "url host connect sign in" },
  { section: "server", id: "ui-source", label: "Screens: automatic, built into the app, or from the server", keywords: "ui source offline copy build interface" },
  { section: "server", id: "ui-check", label: "Check for new screens now", keywords: "manifest build refresh" },
  { section: "library", id: "library-root", label: "Library folder", keywords: "folder documents projects path" },
  { section: "library", id: "naming", label: "File name templates", keywords: "rename series tokens takes renders captions" },
  { section: "library", id: "pull-scope", label: "What a sync pulls: approved shots or the whole cut", keywords: "sync scope download" },
  { section: "library", id: "auto-sync", label: "Re-sync automatically on server changes", keywords: "sync live" },
  { section: "rendering", id: "encoder", label: "Preferred encoder (NVENC, Quick Sync, AMF, software)", keywords: "hardware gpu hevc h264 nvidia intel amd" },
  { section: "rendering", id: "ten-bit", label: "10-bit HEVC for YouTube 4K", keywords: "hdr quality" },
  { section: "rendering", id: "intermediate", label: "Quality of intermediate segments", keywords: "cq crf" },
  { section: "rendering", id: "proxies", label: "Play 1080p proxies", keywords: "proxy mode slow machine" },
  { section: "rendering", id: "gpu-engine", label: "GPU engine (WebGL2) on this PC", keywords: "shader transitions effects webgl" },
  { section: "rendering", id: "backups", label: "Automatic studio backups of edits", keywords: "backup editor upload minutes" },
  { section: "ai-tools", id: "tools", label: "Install or remove Real-ESRGAN, RIFE and Whisper", keywords: "download upscale slow motion transcribe models size" },
  { section: "ai-tools", id: "mediapipe", label: "MediaPipe models", keywords: "segmentation face background" },
  { section: "assistants", id: "assistants", label: "AI assistants", keywords: "mcp claude agent auto edit" },
  { section: "storage", id: "caches", label: "Cache sizes, with Clear", keywords: "disk space clean proxies screens web cache" },
  { section: "storage", id: "low-disk", label: "Low disk space warning (below 15 GB)", keywords: "free space drive" },
  { section: "appearance", id: "theme", label: "Theme: dark, light or system", keywords: "dark mode light mode colour" },
  { section: "appearance", id: "accent", label: "Accent colour", keywords: "color windows accent" },
  { section: "appearance", id: "density", label: "Density: comfortable or compact", keywords: "spacing size" },
  { section: "appearance", id: "scale", label: "UI scale (80 to 150 %)", keywords: "zoom size bigger smaller" },
  { section: "appearance", id: "motion", label: "Reduce motion", keywords: "animation" },
  { section: "appearance", id: "contrast", label: "High contrast", keywords: "accessibility focus" },
  { section: "appearance", id: "material", label: "Window backdrop: Mica, acrylic or solid", keywords: "transparency windows 11 mica" },
  { section: "notifications", id: "kinds", label: "Notify about renders, AI jobs, syncs, updates and downloads", keywords: "toast alerts" },
  { section: "notifications", id: "native", label: "Windows notifications", keywords: "toast action centre" },
  { section: "notifications", id: "tray", label: "Tray icon", keywords: "notification area system tray" },
  { section: "notifications", id: "keep-rendering", label: "Keep rendering when the window is closed", keywords: "background tray close" },
  { section: "shortcuts", id: "shortcut-editor", label: "Editor keyboard shortcuts (Premiere, Resolve, Final Cut)", keywords: "keys bindings keymap" },
  { section: "shortcuts", id: "cheat-sheet", label: "Shortcut cheat sheet", keywords: "keys list" },
  { section: "updates", id: "check", label: "Check for updates now", keywords: "version upgrade" },
  { section: "updates", id: "auto-install", label: "Install updates when the app quits", keywords: "auto update" },
  { section: "updates", id: "notes", label: "Release notes", keywords: "changelog what's new" },
  { section: "advanced", id: "logs", label: "Logs folder", keywords: "debug support" },
  { section: "advanced", id: "gpu", label: "Graphics card information", keywords: "gpu driver webgl" },
  { section: "advanced", id: "restore", label: "Reopen the last windows after a crash", keywords: "recovery session" },
  { section: "advanced", id: "onboarding", label: "Run the first-run steps again", keywords: "welcome getting started setup" },
  { section: "advanced", id: "reset", label: "Reset settings", keywords: "defaults factory" },
];
