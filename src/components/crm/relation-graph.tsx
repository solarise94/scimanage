"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import {
  STAGE_HEX_COLORS,
  RELATION_TYPE_HEX_COLORS,
  STAGE_LABELS,
  RELATION_TYPE_LABELS,
  SYMMETRIC_RELATION_TYPES,
} from "@/lib/crm/constants";
import type { CrmRelationItem } from "@/lib/crm/types";
import { useMediaQuery } from "@/hooks/use-media-query";

interface GraphNode extends SimulationNodeDatum {
  id: string;
  name: string;
  customerCode: string;
  organization: string | null;
  stage: string;
  profileId: string;
  hasCrmProfile: boolean;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  type: string;
  strength: string | null;
}

interface Props {
  relations: CrmRelationItem[];
  profileStages: Map<string, string>;
  profileIdSet: Set<string>;
  onNodeClick?: (node: { profileId: string; name: string }) => void;
}

const NODE_RADIUS = 24;
const FONT_SIZE = 11;

export function RelationGraph({ relations, profileStages, profileIdSet, onNodeClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const router = useRouter();
  const simRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [showLegend, setShowLegend] = useState(false);
  const isMobileGraph = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(svg);
    setSize({ w: svg.clientWidth, h: svg.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const nodeMap = new Map<string, GraphNode>();
    const graphLinks: GraphLink[] = [];

    for (const r of relations) {
      for (const c of [r.fromCustomer, r.toCustomer]) {
        if (!nodeMap.has(c.id)) {
          const hasCrm = profileIdSet.has(c.id);
          nodeMap.set(c.id, {
            id: c.id,
            name: c.name,
            customerCode: c.customerCode,
            organization: c.organization || null,
            stage: profileStages.get(c.id) || "LEAD",
            profileId: c.id,
            hasCrmProfile: hasCrm,
          });
        }
      }
      graphLinks.push({
        id: r.id,
        source: r.fromProfileId ?? r.fromCustomer.id,
        target: r.toProfileId ?? r.toCustomer.id,
        type: r.type,
        strength: r.strength,
      });
    }

    const graphNodes = Array.from(nodeMap.values());

    if (simRef.current) simRef.current.stop();

    const linkDistance = isMobileGraph ? 180 : 120;
    const chargeStrength = isMobileGraph ? -500 : -300;
    const collideRadius = isMobileGraph ? 60 : 48;

    const sim = forceSimulation<GraphNode>(graphNodes)
      .force("link", forceLink<GraphNode, GraphLink>(graphLinks).id((d) => d.id).distance(linkDistance))
      .force("charge", forceManyBody().strength(chargeStrength))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(collideRadius))
      .on("tick", () => {
        setNodes([...graphNodes]);
        setLinks([...graphLinks]);
      });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, [relations, profileStages, profileIdSet, isMobileGraph]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform((t) => {
      const newK = Math.max(0.1, Math.min(5, t.k * factor));
      const rect = svgRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      return {
        k: newK,
        x: mx - (mx - t.x) * (newK / t.k),
        y: my - (my - t.y) * (newK / t.k),
      };
    });
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as SVGElement;
    if (target.closest("[data-node]")) return;
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  }, [transform.x, transform.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current?.dragging) return;
    const d = dragRef.current;
    setTransform((t) => ({ ...t, x: d.origX + e.clientX - d.startX, y: d.origY + e.clientY - d.startY }));
  }, []);

  const handlePointerUp = useCallback(() => { dragRef.current = null; }, []);

  const neighborSet = new Set<string>();
  const highlightLinks = new Set<string>();
  if (hoveredNode) {
    neighborSet.add(hoveredNode);
    for (const l of links) {
      const src = typeof l.source === "object" ? (l.source as GraphNode).id : String(l.source);
      const tgt = typeof l.target === "object" ? (l.target as GraphNode).id : String(l.target);
      if (src === hoveredNode || tgt === hoveredNode) {
        neighborSet.add(src);
        neighborSet.add(tgt);
        highlightLinks.add(l.id);
      }
    }
  }

  const hasDirectional = links.some((l) => !SYMMETRIC_RELATION_TYPES.has(l.type));

  return (
    <div className="relative w-full h-full">
      <svg
        ref={svgRef}
        className="w-full h-full bg-background cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {hasDirectional && (
          <defs>
            {["REFERRED", "REPORTS_TO"].map((type) => (
              <marker key={type} id={`arrow-${type}`} viewBox="0 0 10 6" refX="34" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,3 L0,6 Z" fill={RELATION_TYPE_HEX_COLORS[type] || "var(--muted-foreground)"} />
              </marker>
            ))}
          </defs>
        )}
        <g transform={`translate(${transform.x + size.w / 2}, ${transform.y + size.h / 2}) scale(${transform.k})`}>
          {links.map((l) => {
            const src = l.source as GraphNode;
            const tgt = l.target as GraphNode;
            if (src.x == null || tgt.x == null) return null;
            const color = RELATION_TYPE_HEX_COLORS[l.type] || "var(--muted-foreground)";
            const dimmed = hoveredNode && !highlightLinks.has(l.id);
            const isDirectional = !SYMMETRIC_RELATION_TYPES.has(l.type);
            return (
              <line
                key={l.id}
                x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                stroke={color}
                strokeWidth={l.strength === "STRONG" ? 2.5 : l.strength === "WEAK" ? 1 : 1.5}
                opacity={dimmed ? 0.15 : 0.7}
                markerEnd={isDirectional ? `url(#arrow-${l.type})` : undefined}
                style={{ transition: "opacity 0.2s" }}
              />
            );
          })}
          {nodes.map((n) => {
            if (n.x == null) return null;
            const fill = n.hasCrmProfile ? (STAGE_HEX_COLORS[n.stage] || "var(--muted-foreground)") : "var(--border)";
            const dimmed = hoveredNode && !neighborSet.has(n.id);
            const displayName = isMobileGraph
              ? (n.name.length > 4 ? n.name.slice(0, 3) + "…" : n.name)
              : (n.name.length > 6 ? n.name.slice(0, 5) + "…" : n.name);
            return (
              <g
                key={n.id}
                data-node="true"
                transform={`translate(${n.x},${n.y})`}
                opacity={dimmed ? 0.15 : 1}
                style={{ transition: "opacity 0.2s", cursor: n.hasCrmProfile ? "pointer" : "default" }}
                onPointerEnter={() => setHoveredNode(n.id)}
                onPointerLeave={() => setHoveredNode(null)}
                onClick={() => {
                  if (!n.hasCrmProfile) return;
                  if (onNodeClick) {
                    onNodeClick({ profileId: n.profileId, name: n.name });
                  } else {
                    router.push(`/crm/customers/${n.profileId}`);
                  }
                }}
              >
                <circle r={NODE_RADIUS} fill={fill} stroke={n.hasCrmProfile ? "var(--card)" : "var(--border)"} strokeWidth={2} strokeDasharray={n.hasCrmProfile ? undefined : "4 2"} />
                <text textAnchor="middle" dy={NODE_RADIUS + FONT_SIZE + 2} fontSize={FONT_SIZE} fill="currentColor" className="select-none pointer-events-none">
                  {displayName}
                </text>
              </g>
            );
          })}
        </g>
        {(!isMobileGraph || showLegend) && (
          <g transform="translate(16, 16)">
            <text fontSize={11} fontWeight="bold" fill="currentColor">阶段</text>
            {Object.entries(STAGE_HEX_COLORS).map(([stage, color], i) => (
              <g key={stage} transform={`translate(0, ${16 + i * 16})`}>
                <circle r={5} cx={5} cy={5} fill={color} />
                <text x={16} y={9} fontSize={10} fill="currentColor">{STAGE_LABELS[stage] || stage}</text>
              </g>
            ))}
            <text fontSize={11} fontWeight="bold" fill="currentColor" transform={`translate(0, ${16 + Object.keys(STAGE_HEX_COLORS).length * 16 + 8})`}>关系</text>
            {Object.entries(RELATION_TYPE_HEX_COLORS).map(([type, color], i) => (
              <g key={type} transform={`translate(0, ${16 + Object.keys(STAGE_HEX_COLORS).length * 16 + 24 + i * 16})`}>
                <line x1={0} y1={5} x2={12} y2={5} stroke={color} strokeWidth={2} />
                <text x={16} y={9} fontSize={10} fill="currentColor">{RELATION_TYPE_LABELS[type] || type}</text>
              </g>
            ))}
          </g>
        )}
      </svg>
      {isMobileGraph && (
        <button
          type="button"
          className="absolute bottom-3 right-3 rounded-full bg-background/90 border px-3 py-1 text-xs shadow"
          onClick={() => setShowLegend((v) => !v)}
        >
          {showLegend ? "隐藏图例" : "图例"}
        </button>
      )}
    </div>
  );
}
