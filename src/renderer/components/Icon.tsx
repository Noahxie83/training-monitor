import React from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Filter,
  FolderOpen,
  HardDrive,
  Info,
  Languages,
  Layers,
  LineChart,
  MemoryStick,
  Monitor,
  Moon,
  MoreHorizontal,
  OctagonX,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Thermometer,
  Trash2,
  WrapText,
  X,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const ICONS = {
  activity: Activity,
  alertCircle: AlertCircle,
  bell: Bell,
  chart: LineChart,
  check: Check,
  checkCircle: CheckCircle2,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  clock: Clock,
  close: X,
  copy: Copy,
  cpu: Cpu,
  download: Download,
  external: ExternalLink,
  file: FileText,
  filter: Filter,
  folder: FolderOpen,
  gpu: Cpu,
  hardDrive: HardDrive,
  info: Info,
  kill: OctagonX,
  languages: Languages,
  layers: Layers,
  memory: MemoryStick,
  monitor: Monitor,
  moon: Moon,
  more: MoreHorizontal,
  pause: Pause,
  play: Play,
  plus: Plus,
  radar: Radar,
  refresh: RefreshCw,
  restart: RotateCcw,
  search: Search,
  server: Server,
  settings: Settings,
  shield: ShieldCheck,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  stop: Square,
  sun: Sun,
  terminal: Terminal,
  thermometer: Thermometer,
  trash: Trash2,
  warning: AlertTriangle,
  wrap: WrapText,
  xCircle: XCircle,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className = '',
  size = 16,
}: {
  name: IconName;
  className?: string;
  size?: number;
}) {
  const Component = ICONS[name];
  return (
    <Component
      className={`ui-icon ${className}`.trim()}
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
