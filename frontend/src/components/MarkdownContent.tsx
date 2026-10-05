import Box from '@mui/material/Box'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Styled markdown renderer shared by AI chat bubbles and analysis panels. */
export default function MarkdownContent({ content }: { content: string }) {
  return (
    <Box
      sx={{
        fontSize: '0.875rem',
        lineHeight: 1.75,
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
        color: 'text.primary',
        '& > :first-of-type': { mt: 0 },
        '& > :last-of-type': { mb: 0 },
        '& p': { my: 0.875 },
        '& ul, & ol': { my: 0.875, pl: 1.75 },
        '& li': { my: 0.25 },
        '& li > p': { my: 0 },
        '& h1, & h2, & h3, & h4': { fontWeight: 600, lineHeight: 1.25, color: 'text.primary' },
        '& h1': { fontSize: '1.2rem', mt: 1.5, mb: 0.75 },
        '& h2': { fontSize: '1.075rem', mt: 1.5, mb: 0.625 },
        '& h3': { fontSize: '1rem', mt: 1.25, mb: 0.5 },
        '& h4': { fontSize: '0.9375rem', mt: 1.25, mb: 0.5 },
        '& a': { color: 'primary.main', fontWeight: 500 },
        '& strong': { fontWeight: 600 },
        '& blockquote': {
          borderLeft: 4,
          borderColor: 'divider',
          pl: 1.25,
          my: 1,
          color: 'text.secondary',
          fontStyle: 'italic',
        },
        '& table': { borderCollapse: 'collapse', my: 1, width: '100%', fontSize: '0.8125rem' },
        '& th, & td': { border: 1, borderColor: 'divider', p: 0.5, textAlign: 'left' },
        '& hr': { my: 1.5, borderColor: 'divider' },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <Box
              component="pre"
              sx={{
                my: 1,
                p: 1.25,
                bgcolor: 'rgba(0,0,0,0.06)',
                borderRadius: 1,
                overflowX: 'auto',
                fontFamily: 'Consolas, monospace',
                fontSize: '0.8125rem',
                lineHeight: 1.6,
              }}
            >
              {children}
            </Box>
          ),
          code: ({ children, className }) => {
            const text = children
            const isBlock = /language-/.test(className || '') || String(text).includes('\n')
            return (
              <code
                style={
                  isBlock
                    ? {
                        fontFamily: 'Consolas, monospace',
                        fontSize: '0.875em',
                        whiteSpace: 'pre-wrap',
                      }
                    : {
                        fontFamily: 'Consolas, monospace',
                        fontSize: '0.875em',
                        backgroundColor: 'rgba(0,0,0,0.05)',
                        padding: '0.125em 0.375em',
                        borderRadius: 4,
                        whiteSpace: 'pre-wrap',
                      }
                }
              >
                {children}
              </code>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  )
}
