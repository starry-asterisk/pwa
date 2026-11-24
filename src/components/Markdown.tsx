import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
export default function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="external-image-label">[외부 이미지: {alt || '이미지'}]</span>,
  }}>{text}</ReactMarkdown></div>
}