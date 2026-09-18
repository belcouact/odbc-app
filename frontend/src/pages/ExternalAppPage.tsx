import Box from '@mui/material/Box'

interface ExternalAppPageProps {
  /** URL of the external web app to embed. */
  url: string
  /** iframe title (accessibility). */
  title: string
  /** True while this tab is visible. */
  active?: boolean
}

/** Full-height page that embeds an external web app inside the tab. */
export default function ExternalAppPage({ url, title }: ExternalAppPageProps) {
  return (
    <Box sx={{ width: '100%', height: 'calc(100vh - 56px)' }}>
      <iframe
        src={url}
        title={title}
        style={{ border: 0, width: '100%', height: '100%' }}
        loading="lazy"
        allowFullScreen
      />
    </Box>
  )
}
