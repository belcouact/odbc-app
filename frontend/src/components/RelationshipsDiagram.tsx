/**
 * Relationship diagram (BI page) — every saved relationship drawn as a line
 * between its two tables. Left joins are solid blue lines, inner joins dashed
 * green, and each line is labelled with its key pair and arrowed left → right,
 * so the diagram doubles as a mini schema map of the warehouse.
 */

import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import LinkIcon from '@mui/icons-material/Link'
import type { EChartsOption } from 'echarts'
import EChart from './EChart'
import type { SnapshotRelationship } from '../api/client'

/** Join-type line colors (kept in sync with the legend chips below). */
const JOIN_COLORS: Record<string, string> = {
  left: '#1976d2',
  inner: '#2e7d32',
}

/** Line dash pattern per join type (undefined = solid). */
const JOIN_DASH: Record<string, number[] | undefined> = {
  left: undefined,
  inner: [6, 4],
}

function joinColor(joinType: string): string {
  return JOIN_COLORS[joinType] ?? '#9e9e9e'
}

interface RelationshipsDiagramProps {
  relationships: SnapshotRelationship[]
  /** Canvas height in px (the dialog picks a smaller one on phones). */
  height?: number
}

export default function RelationshipsDiagram({ relationships, height = 440 }: RelationshipsDiagramProps) {
  // A relationship between a table and itself draws no edge in ECharts, so it
  // is surfaced as a chip instead of a line.
  const edges = relationships.filter((item) => item.left_snapshot_id !== item.right_snapshot_id)
  const selfJoins = relationships.filter((item) => item.left_snapshot_id === item.right_snapshot_id)

  /** Distinct table names on either side of the drawn relationships. */
  const tableNames = Array.from(
    new Set(edges.flatMap((item) => [item.left_name, item.right_name])),
  )

  /** How many edges already connect each pair, so duplicate lines fan apart. */
  const pairCounters = new Map<string, number>()

  const option: EChartsOption = {
    tooltip: {
      confine: true,
      formatter: (params: unknown) => {
        const p = params as {
          dataType?: string
          data?: Record<string, unknown>
          name?: string
        }
        if (p.dataType === 'edge') {
          const data = p.data ?? {}
          return `<strong>${data.relName ?? ''}</strong><br/>${data.lname ?? ''}.${data.lcol ?? ''} = ${data.rname ?? ''}.${data.rcol ?? ''}<br/>${data.jtype ?? ''} join`
        }
        const count = Number(p.data?.relCount ?? 0)
        return `<strong>${p.name ?? ''}</strong><br/>${count} relationship${count === 1 ? '' : 's'}`
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'circular',
        // Pin the ring away from the edges so labels are not clipped.
        circular: { rotateLabel: false },
        roam: 'scale',
        zoom: 0.9,
        emphasis: { focus: 'adjacency' },
        data: tableNames.map((name) => ({
          id: name,
          name,
          symbol: 'rect',
          symbolSize: [Math.max(90, Math.min(150, name.length * 8 + 30)), 44],
          relCount: relationships.filter(
            (item) => item.left_name === name || item.right_name === name,
          ).length,
          itemStyle: {
            color: '#eef4fb',
            borderColor: '#5b7ea6',
            borderWidth: 1.5,
            borderRadius: 8,
          },
          label: {
            show: true,
            formatter: name.length > 16 ? `${name.slice(0, 15)}…` : name,
            fontSize: 12,
            color: '#1f2937',
            fontWeight: 600,
            overflow: 'truncate',
          },
        })),
        links: edges.map((item) => {
          const pairKey = [item.left_name, item.right_name].sort().join('\u0000')
          const seen = pairCounters.get(pairKey) ?? 0
          pairCounters.set(pairKey, seen + 1)
          return {
            source: item.left_name,
            target: item.right_name,
            // Alternate the curve direction when two relationships link the
            // same pair of tables, so both lines stay readable.
            lineStyle: {
              color: joinColor(item.join_type),
              width: 2,
              type: JOIN_DASH[item.join_type] ? [6, 4] : 'solid',
              curveness: seen % 2 === 0 ? 0.18 : -0.18,
              opacity: 0.9,
            },
            symbol: ['none', 'arrow'],
            symbolSize: 8,
            label: {
              show: true,
              formatter: `${item.left_column} = ${item.right_column}`,
              fontSize: 10,
              color: joinColor(item.join_type),
              backgroundColor: 'rgba(255,255,255,0.9)',
              padding: [2, 5],
              borderRadius: 3,
            },
            relName: item.name,
            lname: item.left_name,
            lcol: item.left_column,
            rname: item.right_name,
            rcol: item.right_column,
            jtype: item.join_type,
          }
        }),
      },
    ],
  }

  if (edges.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
        {relationships.length === 0
          ? 'No relationships to draw yet.'
          : 'Only same-table relationships exist — they are listed below.'}
      </Typography>
    )
  }

  return (
    <Box>
      <Box sx={{ height, width: '100%' }}>
        <EChart option={option} />
      </Box>
      {/* Join-type legend */}
      <StackLegend />
      {selfJoins.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Same-table relationships (not drawn):
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {selfJoins.map((item) => (
              <Chip
                key={item.id}
                size="small"
                variant="outlined"
                icon={<LinkIcon />}
                label={`${item.name} · ${item.left_column} = ${item.right_column}`}
              />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** Legend explaining the line styles (colors match JOIN_COLORS above). */
function StackLegend() {
  const entries = [
    { label: 'Left join — keeps unmatched left rows', color: JOIN_COLORS.left, dashed: false },
    { label: 'Inner join — matches only', color: JOIN_COLORS.inner, dashed: true },
  ]
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center', mt: 0.5 }}>
      {entries.map((entry) => (
        <Box key={entry.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box
            sx={{
              width: 28,
              borderTop: `2.5px ${entry.dashed ? 'dashed' : 'solid'} ${entry.color}`,
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {entry.label}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}
