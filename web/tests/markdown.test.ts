import { describe, expect, it } from 'vitest'

import { renderInline, renderMarkdown } from '../src/commands/markdown'

/** UT-markdown：极简 Markdown 渲染（ADR-0012 γ）—— 只认 AI 回答里常见的那一撮，输出全转义。 */
describe('renderMarkdown', () => {
  it('标题 / 段落 / 列表', () => {
    const html = renderMarkdown('## context\n\n用于取消。\n第二行并入段落。\n\n- 一\n- 二\n\n1. 甲\n2. 乙')
    expect(html).toContain('<h2>context</h2>')
    expect(html).toContain('<p>用于取消。 第二行并入段落。</p>')
    expect(html).toContain('<ul><li>一</li><li>二</li></ul>')
    expect(html).toContain('<ol><li>甲</li><li>乙</li></ol>')
  })
  it('围栏代码：原样、转义、带语言类；没闭合吃到末尾', () => {
    const html = renderMarkdown('```go\nif a < b { fmt.Println("<x>") }\n```\n尾巴')
    expect(html).toContain('<pre><code class="lang-go">if a &lt; b { fmt.Println(&quot;&lt;x&gt;&quot;) }</code></pre>')
    expect(html).toContain('<p>尾巴</p>')
    expect(renderMarkdown('```\nopen')).toBe('<pre><code>open</code></pre>')
  })
  it('行内：代码 / 粗体 / 斜体 / 链接（只放 http(s)），文本全转义', () => {
    expect(renderInline('用 `a*b` 与 **粗** 和 *斜*')).toBe('用 <code>a*b</code> 与 <strong>粗</strong> 和 <em>斜</em>')
    expect(renderInline('[站](https://x.y/z) [坏](javascript:alert(1))')).toBe(
      '<a href="https://x.y/z" target="_blank" rel="noopener noreferrer">站</a> 坏',
    )
    expect(renderInline('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;')
    expect(renderInline('snake_case_name 不是斜体')).toBe('snake_case_name 不是斜体')
  })
  it('引用 / 分隔线 / 表格', () => {
    const html = renderMarkdown('> 引用\n> 两行\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<blockquote><p>引用 两行</p></blockquote>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>')
  })
  it('CRLF 也认；空输入给空', () => {
    expect(renderMarkdown('a\r\n\r\nb')).toBe('<p>a</p>\n<p>b</p>')
    expect(renderMarkdown('')).toBe('')
  })
})
