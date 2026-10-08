/** Developer-only component gallery (route /dev/kit, available in `npm run dev` builds only). */
import { Bell, Check, Copy, Download, Film, Mic, MoreHorizontal, Play, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Alert, Avatar, AvatarStack, Badge, Button, Card, Empty, Field, IconButton, InView, Input, Kbd, Menu, Modal, Page, PageHeader, Popover,
  Progress, ProgressRing, ScrollStrip, SearchField, Section, Segmented, Select, Skeleton, SkeletonText, Sparkline, Stat, Tabs, Textarea,
  Toggle, Tooltip, rise,
} from "../../components/ui";

const SWATCHES = [
  ["bg", "bg-bg"], ["panel", "bg-panel"], ["raised", "bg-raised"], ["hover", "bg-hover"], ["line", "bg-line"],
  ["ink", "bg-ink"], ["mute", "bg-mute"], ["dim", "bg-dim"], ["accent", "bg-accent"], ["ok", "bg-ok"], ["warn", "bg-warn"], ["bad", "bg-bad"], ["info", "bg-info"],
] as const;

export default function KitGallery() {
  const [tab, setTab] = useState("one");
  const [seg, setSeg] = useState("a");
  const [on, setOn] = useState(true);
  const [q, setQ] = useState("");
  const [modal, setModal] = useState(false);
  const [pop, setPop] = useState(false);
  const popRef = useRef<HTMLButtonElement>(null);
  const [loading, setLoading] = useState(false);

  return (
    <Page width="wide">
      <PageHeader title="Component gallery" subtitle="Every shared building block, in the current theme. Toggle the theme from the sidebar user menu." icon={<Sparkles className="size-5" />}
        actions={<Button variant="primary" icon={<Plus className="size-4" />}>New</Button>} />

      <Section title="Colour tokens">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
          {SWATCHES.map(([name, cls], i) => (
            <div key={name} {...rise(i)} className={`anim-rise rounded-xl border border-line p-2`} style={rise(i).style}>
              <div className={`${cls} h-12 rounded-lg border border-line`} />
              <p className="mt-1.5 text-xs font-medium">{name}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-1 rounded-xl border border-line bg-panel p-4">
          <p className="text-ink">ink — primary text: The quick brown fox jumps over the lazy dog</p>
          <p className="text-mute">mute — secondary text: The quick brown fox jumps over the lazy dog</p>
          <p className="text-dim">dim — hints and meta: The quick brown fox jumps over the lazy dog</p>
          <p className="text-accent-ink">accent-ink — accent text and icons</p>
          <p className="text-ok">ok · <span className="text-warn">warn</span> · <span className="text-bad">bad</span> · <span className="text-info">info</span></p>
        </div>
      </Section>

      <Section title="Typography">
        <div className="space-y-1 rounded-xl border border-line bg-panel p-4">
          <p className="text-3xl font-semibold tracking-tight">text-3xl — hero</p>
          <p className="text-2xl font-semibold tracking-tight">text-2xl — page title</p>
          <p className="text-xl font-semibold tracking-tight">text-xl — section</p>
          <p className="text-lg font-semibold tracking-tight">text-lg — card title</p>
          <p className="text-base">text-base — long reading</p>
          <p className="text-sm">text-sm — default UI text. Numbers: <span className="tabular-nums">$1,234.56 · 00:12:04:08</span></p>
          <p className="text-xs">text-xs — labels and metadata</p>
          <p className="text-2xs">text-2xs — hints, badges (the minimum)</p>
          <p lang="hi" className="text-sm">हिन्दी — यह एक परीक्षण वाक्य है · <span lang="kn">ಕನ್ನಡ ಪರೀಕ್ಷೆ</span> · <span lang="te">తెలుగు పరీక్ష</span> · <span lang="ta">தமிழ் சோதனை</span></p>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          {(["primary", "secondary", "outline", "ghost", "danger"] as const).map((v) => <Button key={v} variant={v}>{v}</Button>)}
          <Button variant="primary" icon={<Wand2 className="size-4" />}>With icon</Button>
          <Button variant="outline" iconRight={<Download className="size-4" />}>Icon right</Button>
          <Button variant="primary" loading={loading} onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1500); }}>Click to load</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button><Button size="lg" variant="primary">Large</Button>
          <IconButton title="Copy" shortcut={<Kbd>C</Kbd>}><Copy className="size-4" /></IconButton>
          <IconButton title="Active" active><Play className="size-4" /></IconButton>
          <IconButton title="Disabled" disabled><Trash2 className="size-4" /></IconButton>
        </div>
      </Section>

      <Section title="Form controls">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Text input" hint="Helper text sits below"><Input placeholder="Type something…" /></Field>
          <Field label="Select" hint="Custom chevron, never truncated"><Select defaultValue="b"><option value="a">Short</option><option value="b">A much longer option label that needs room</option></Select></Field>
          <Field label="Search"><SearchField value={q} onChange={setQ} placeholder="Search…" shortcut={<Kbd>/</Kbd>} /></Field>
          <Field label="Textarea" className="md:col-span-2"><Textarea placeholder="Write a longer note…" /></Field>
          <div className="space-y-3">
            <Toggle checked={on} onChange={setOn} label="Toggle switch" />
            <Toggle checked={false} onChange={() => {}} disabled label="Disabled" />
            <Segmented value={seg} onChange={setSeg} options={[{ value: "a", label: "Saver" }, { value: "b", label: "Balanced" }, { value: "c", label: "Hero" }]} />
          </div>
        </div>
      </Section>

      <Section title="Tabs, badges, alerts">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: "one", label: "Overview" }, { value: "two", label: "Takes", count: 8 }, { value: "three", label: "Comments", count: 2 }]} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(["neutral", "accent", "ok", "warn", "bad", "info"] as const).map((t) => <Badge key={t} tone={t} dot>{t}</Badge>)}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Alert tone="info" title="Heads up">Informational message with some supporting detail.</Alert>
          <Alert tone="warn" title="Careful" action={<Button size="sm">Fix</Button>}>Something needs attention before you continue.</Alert>
          <Alert tone="bad" title="Failed">Couldn't finish that. Try again.</Alert>
          <Alert tone="ok" title="All good">Everything saved.</Alert>
        </div>
      </Section>

      <Section title="Cards, stats, progress">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          <Stat index={0} label="Spent this month" value={42.5} format={(n) => `$${n.toFixed(2)}`} icon={<Film className="size-4" />} tone="accent" sub="of $100.00 cap">
            <Progress value={0.425} className="mt-3" />
          </Stat>
          <Stat index={1} label="Videos made" value={128} icon={<Play className="size-4" />} tone="ok" sub="+12 this week" />
          <Stat index={2} label="Trend" value="↗ 18%" icon={<Mic className="size-4" />} tone="info"><Sparkline data={[3, 5, 4, 8, 6, 9, 12, 10, 14]} className="mt-2" /></Stat>
          <Card className="p-4" interactive onClick={() => toast.success("Card clicked")}>
            <p className="font-medium">Interactive card</p><p className="mt-1 text-sm text-mute">Hover to lift. Click for a toast.</p>
          </Card>
          <Card className="flex items-center gap-4 p-4"><ProgressRing value={0.72}>72</ProgressRing><div><p className="font-medium">Progress ring</p><p className="text-xs text-dim">Animated stroke</p></div></Card>
          <Card className="space-y-3 p-4"><Progress value={0.3} size="sm" /><Progress value={0.6} tone="ok" /><Progress indeterminate size="lg" /></Card>
        </div>
      </Section>

      <Section title="Loading and empty">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="space-y-3 p-4"><Skeleton className="h-28" /><SkeletonText lines={3} /></Card>
          <Empty icon={<Film className="size-7" />} title="Nothing here yet" sub="Empty states explain what belongs here and offer the next step." action={<Button variant="primary" icon={<Plus className="size-4" />}>Create one</Button>} />
        </div>
      </Section>

      <Section title="Overlays and people">
        <div className="flex flex-wrap items-center gap-4">
          <Tooltip content="A tooltip" shortcut={<Kbd>T</Kbd>}><Button variant="outline">Hover me</Button></Tooltip>
          <Menu trigger={(p) => <IconButton title="More" {...p}><MoreHorizontal className="size-4" /></IconButton>}
            items={[{ label: "Open", icon: <Play className="size-4" /> }, { label: "Duplicate", icon: <Copy className="size-4" />, shortcut: <Kbd>D</Kbd> }, { label: "Archive", separator: true }, { label: "Delete", icon: <Trash2 className="size-4" />, danger: true }]} />
          <Button ref={popRef} variant="outline" onClick={() => setPop((v) => !v)}>Popover</Button>
          <Popover open={pop} onClose={() => setPop(false)} anchor={popRef} placement="bottom-start" width={260} className="p-3"><p className="text-sm font-medium">Anchored panel</p><p className="mt-1 text-xs text-mute">Closes on outside click and Esc; flips near edges.</p></Popover>
          <Button variant="outline" onClick={() => setModal(true)}>Open modal</Button>
          <Button variant="outline" icon={<Bell className="size-4" />} onClick={() => toast.success("Saved", { description: "Your changes are live." })}>Success toast</Button>
          <Button variant="outline" onClick={() => toast.error("That didn't work", { description: "Network error — try again." })}>Error toast</Button>
          <Avatar name="Dev Admin" /><Avatar name="Meera Rao" size={36} /><AvatarStack names={["Ravi K", "Meera R", "Asha P", "Dev A", "Zoya T", "Kiran M"]} />
          <Kbd>Ctrl</Kbd><Kbd>K</Kbd>
        </div>
        <Modal open={modal} onClose={() => setModal(false)} title="Example dialog" footer={<><Button variant="ghost" onClick={() => setModal(false)}>Cancel</Button><Button variant="primary" onClick={() => setModal(false)}>Confirm</Button></>}>
          <Field label="Name"><Input autoFocus placeholder="Focus lands here" /></Field>
          <p className="mt-3 text-sm text-mute">Tab stays inside the dialog; Esc closes it; focus returns to the button that opened it.</p>
        </Modal>
      </Section>

      <Section title="Scroll strip">
        <ScrollStrip className="max-w-md">
          <div className="flex gap-2 pr-6">{Array.from({ length: 14 }, (_, i) => <Badge key={i} tone={i === 3 ? "accent" : "neutral"}>Chip number {i + 1}</Badge>)}</div>
        </ScrollStrip>
      </Section>

      <InView><Card className="flex items-center gap-3 p-4"><Check className="size-5 text-ok" /><p className="text-sm">This card fades in when scrolled into view (InView).</p></Card></InView>
    </Page>
  );
}
