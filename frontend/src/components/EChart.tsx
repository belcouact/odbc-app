import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import Box from '@mui/material/Box'

interface EChartProps {
  option: EChartsOption | null
}

/**
 * Thin ECharts host: it owns the instance lifecycle and nothing else.
 *
 * Extracted so the chart builder and every dashboard tile share one correct
 * init / resize / dispose path. The parent controls the size — this fills it.
 * `setOption(option, true)` replaces rather than merges, so switching chart
 * type never leaves stale series behind.
 */
export default function EChart({ option }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    setReady(true)
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    if (ready && chartRef.current && option) {
      chartRef.current.setOption(option, true)
      // The chart may have been created while hidden (0-sized container);
      // force a redraw so the option is actually painted.
      chartRef.current.resize()
    }
  }, [option, ready])

  return <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />
}
