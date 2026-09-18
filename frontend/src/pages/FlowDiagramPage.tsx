import ExternalAppPage from './ExternalAppPage'

const DEMO_URL = 'https://next-ai-drawio.jiang.jp/'

interface FlowDiagramPageProps {
  /** True while the FlowDiagram tab is visible. */
  active?: boolean
}

export default function FlowDiagramPage(props: FlowDiagramPageProps) {
  return <ExternalAppPage url={DEMO_URL} title="FlowDiagram — next-ai-draw-io" active={props.active} />
}
