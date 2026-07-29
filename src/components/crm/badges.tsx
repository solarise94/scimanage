"use client";

import {
  STAGE_LABELS,
  STAGE_COLORS,
  IMPORTANCE_LABELS,
  IMPORTANCE_COLORS,
  FOLLOW_UP_STATUS_LABELS,
  FOLLOW_UP_STATUS_COLORS,
  RELATION_TYPE_LABELS,
  RELATION_TYPE_COLORS,
  ASSIGNMENT_STATUS_LABELS,
  ASSIGNMENT_STATUS_COLORS,
  PERSON_CATEGORY_LABELS,
  PERSON_CATEGORY_COLORS,
  GRADUATION_STATUS_LABELS,
  GRADUATION_STATUS_COLORS,
} from "@/lib/crm/constants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  Target,
  PhoneCall,
  Clock,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Moon,
  Sparkles,
  ArrowDown,
  Minus,
  AlertTriangle,
  Flame,
  Circle,
  CheckCircle,
  AlertCircle,
  UserPlus,
  Users,
  ArrowUp,
  UsersRound,
  FlaskConical,
  HelpCircle,
  CircleDashed,
  RotateCcw,
  GraduationCap,
  Microscope,
  Crown,
  Wrench,
  Stethoscope,
  UserCog,
  ShoppingCart,
  User,
  BookOpen,
} from "lucide-react";

const STAGE_ICONS: Record<string, LucideIcon> = {
  LEAD: Target,
  CONTACTED: PhoneCall,
  FOLLOWING: Clock,
  ACTIVE: CheckCircle2,
  BLOCKED: XCircle,
  LOST: MinusCircle,
  DORMANT: Moon,
  NEW: Sparkles,
};

const IMPORTANCE_ICONS: Record<string, LucideIcon> = {
  LOW: ArrowDown,
  NORMAL: Minus,
  HIGH: AlertTriangle,
  KEY: Flame,
};

const FOLLOW_UP_ICONS: Record<string, LucideIcon> = {
  OPEN: Circle,
  DONE: CheckCircle,
  CANCELLED: XCircle,
  EXPIRED: AlertCircle,
};

const RELATION_ICONS: Record<string, LucideIcon> = {
  REFERRED: UserPlus,
  COLLABORATES_WITH: Users,
  REPORTS_TO: ArrowUp,
  SAME_GROUP: UsersRound,
  SAME_LAB: FlaskConical,
  OTHER: HelpCircle,
};

const ASSIGNMENT_ICONS: Record<string, LucideIcon> = {
  UNASSIGNED: CircleDashed,
  ASSIGNED: CheckCircle,
  RECALL_CANDIDATE: AlertTriangle,
  RECALLED: RotateCcw,
};

const PERSON_CATEGORY_ICONS: Record<string, LucideIcon> = {
  STUDENT: GraduationCap,
  POSTDOC: Microscope,
  RESEARCHER: FlaskConical,
  PI: Crown,
  TECHNICIAN: Wrench,
  CLINICIAN: Stethoscope,
  ADMIN: UserCog,
  PROCUREMENT: ShoppingCart,
  OTHER: User,
};

const GRADUATION_ICONS: Record<string, LucideIcon> = {
  ENROLLED: BookOpen,
  GRADUATING_SOON: Clock,
  GRADUATED: GraduationCap,
  UNKNOWN: HelpCircle,
};

const fallbackClass = "bg-neutral-bg text-neutral";

function CrmBadge({
  label,
  className,
  Icon,
}: {
  label: string;
  className?: string;
  Icon?: LucideIcon;
}) {
  return (
    <Badge className={cn("gap-1 whitespace-nowrap", className)}>
      {Icon && <Icon className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  const Icon = STAGE_ICONS[stage];
  return (
    <CrmBadge
      label={STAGE_LABELS[stage] || stage}
      className={STAGE_COLORS[stage] || fallbackClass}
      Icon={Icon}
    />
  );
}

export function ImportanceBadge({ importance }: { importance: string }) {
  const Icon = IMPORTANCE_ICONS[importance];
  return (
    <CrmBadge
      label={IMPORTANCE_LABELS[importance] || importance}
      className={IMPORTANCE_COLORS[importance] || fallbackClass}
      Icon={Icon}
    />
  );
}

export function FollowUpStatusBadge({ status }: { status: string }) {
  const Icon = FOLLOW_UP_ICONS[status];
  return (
    <CrmBadge
      label={FOLLOW_UP_STATUS_LABELS[status] || status}
      className={FOLLOW_UP_STATUS_COLORS[status] || fallbackClass}
      Icon={Icon}
    />
  );
}

export function RelationTypeBadge({ type }: { type: string }) {
  const Icon = RELATION_ICONS[type];
  return (
    <CrmBadge
      label={RELATION_TYPE_LABELS[type] || type}
      className={RELATION_TYPE_COLORS[type] || fallbackClass}
      Icon={Icon}
    />
  );
}

export function AssignmentStatusBadge({ status }: { status: string }) {
  const Icon = ASSIGNMENT_ICONS[status];
  return (
    <CrmBadge
      label={ASSIGNMENT_STATUS_LABELS[status] || status}
      className={ASSIGNMENT_STATUS_COLORS[status] || fallbackClass}
      Icon={Icon}
    />
  );
}

export function PersonCategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  const Icon = PERSON_CATEGORY_ICONS[category];
  return (
    <CrmBadge
      label={PERSON_CATEGORY_LABELS[category] || category}
      className={PERSON_CATEGORY_COLORS[category] || fallbackClass}
      Icon={Icon}
    />
  );
}

export function GraduationStatusBadge({ status }: { status: string | null }) {
  if (!status || status === "NOT_APPLICABLE") return null;
  const Icon = GRADUATION_ICONS[status];
  return (
    <CrmBadge
      label={GRADUATION_STATUS_LABELS[status] || status}
      className={GRADUATION_STATUS_COLORS[status] || fallbackClass}
      Icon={Icon}
    />
  );
}
