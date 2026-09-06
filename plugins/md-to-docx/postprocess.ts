import { existsSync, readFileSync, writeFileSync } from "node:fs"
import AdmZip from "adm-zip"
import { DOMParser, XMLSerializer } from "@xmldom/xmldom"
import { DocxTheme, DEFAULT_DOCX_THEME } from "./style-parser"

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

function findChildrenByTag(parent: any, localName: string): any[] {
  const result: any[] = []
  if (!parent || !parent.childNodes) return result
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes[i]
    if (node.nodeType === 1) { // Element
      const nodeLocal = node.localName || node.nodeName.replace(/^.*:/, "")
      if (nodeLocal === localName) {
        result.push(node)
      }
    }
  }
  return result
}

function findDescendantsByTag(parent: any, localName: string): any[] {
  const result: any[] = []
  if (!parent) return result
  function traverse(node: any) {
    if (node.nodeType === 1) {
      const nodeLocal = node.localName || node.nodeName.replace(/^.*:/, "")
      if (nodeLocal === localName) {
        result.push(node)
      }
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i])
        }
      }
    }
  }
  traverse(parent)
  return result
}

function findFirstChild(parent: any, localName: string): any | null {
  const res = findChildrenByTag(parent, localName)
  return res.length > 0 ? res[0] : null
}

function findFirstDescendant(parent: any, localName: string): any | null {
  const res = findDescendantsByTag(parent, localName)
  return res.length > 0 ? res[0] : null
}

function getTextContent(node: any): string {
  let text = ""
  if (!node) return ""
  if (node.nodeType === 3) {
    return node.nodeValue || ""
  }
  if (node.childNodes) {
    for (let i = 0; i < node.childNodes.length; i++) {
      text += getTextContent(node.childNodes[i])
    }
  }
  return text
}

function getStyleVal(elem: any): string {
  const pPr = findFirstChild(elem, "pPr")
  if (!pPr) return ""
  const pStyle = findFirstChild(pPr, "pStyle")
  if (!pStyle) return ""
  return pStyle.getAttribute("w:val") || pStyle.getAttribute("val") || ""
}

function getCjkStringWidth(s: string): number {
  let width = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      width += 2.0
    } else {
      width += 1.0
    }
  }
  return width
}

/**
 * 1:1 Complete OpenXML Beautification Engine (100% Stylesheet Parameterized)
 */
export function postprocessDocxXml(docxPath: string, theme: DocxTheme = DEFAULT_DOCX_THEME): boolean {
  if (!existsSync(docxPath)) return false

  try {
    const zip = new AdmZip(docxPath)
    const docEntry = zip.getEntry("word/document.xml")
    if (!docEntry) return false

    const docXmlStr = zip.readAsText(docEntry, "utf8")
    const parser = new DOMParser()
    const doc = parser.parseFromString(docXmlStr, "text/xml")
    const docElement = doc.documentElement

    const body = findFirstChild(docElement, "body")
    if (!body) return false

    // === 1. 扫描与中文化 TOC 目录 ===
    const sdtElements = findDescendantsByTag(body, "sdt")
    let tocSdt: any = null

    for (const sdt of sdtElements) {
      const docPartObj = findFirstDescendant(sdt, "docPartObj")
      const isToc = docPartObj && getTextContent(docPartObj).includes("Table of Contents")
      const texts = findDescendantsByTag(sdt, "t")
      const hasTocText = texts.some((t: any) => getTextContent(t).includes("Table of Contents") || getTextContent(t) === "目录" || getTextContent(t) === theme.tocTitle)

      if (isToc || hasTocText) {
        tocSdt = sdt
        for (const t of texts) {
          if (t.textContent && (t.textContent.includes("Table of Contents") || t.textContent === "目录")) {
            t.textContent = theme.tocTitle
          }
        }
        const pElements = findDescendantsByTag(sdt, "p")
        for (const p of pElements) {
          const style = getStyleVal(p)
          if (style === "TOCHeading" || style === "Heading1") {
            let pPr = findFirstChild(p, "pPr")
            if (!pPr) {
              pPr = doc.createElementNS(W_NS, "w:pPr")
              p.insertBefore(pPr, p.firstChild)
            }
            let jc = findFirstChild(pPr, "jc")
            if (!jc) {
              jc = doc.createElementNS(W_NS, "w:jc")
              pPr.appendChild(jc)
            }
            jc.setAttribute("w:val", theme.tocAlign)
          }
        }
      }
    }

    // === 2. 封面重构与元数据美化 (将 H1 + 封面元数据置于 TOC 前) ===
    if (tocSdt) {
      const bodyChildren: any[] = []
      for (let i = 0; i < body.childNodes.length; i++) {
        if (body.childNodes[i].nodeType === 1) {
          bodyChildren.push(body.childNodes[i])
        }
      }

      const tocIdx = bodyChildren.indexOf(tocSdt)
      if (tocIdx !== -1) {
        let h1Elem: any = null
        const metaElems: any[] = []
        let scan = tocIdx + 1

        while (scan < bodyChildren.length) {
          const e = bodyChildren[scan]
          const tag = e.localName || e.nodeName.replace(/^.*:/, "")
          if (tag === "bookmarkStart" || tag === "bookmarkEnd") {
            scan++
            continue
          }
          if (tag === "p" && !h1Elem) {
            if (getStyleVal(e) === "Heading1") {
              h1Elem = e
              scan++
              continue
            }
          }
          if (h1Elem && tag === "p") {
            const style = getStyleVal(e)
            if (style === "FirstParagraph" || style === "") {
              metaElems.push(e)
              scan++
              continue
            }
          }
          break
        }

        if (h1Elem) {
          const h1Idx = bodyChildren.indexOf(h1Elem)
          const lastMetaIdx = metaElems.length > 0 ? bodyChildren.indexOf(metaElems[metaElems.length - 1]) : h1Idx
          const coverRange = bodyChildren.slice(h1Idx, lastMetaIdx + 1)

          for (const ce of coverRange) {
            body.removeChild(ce)
          }
          for (const ce of coverRange) {
            body.insertBefore(ce, tocSdt)
          }
        }
      }

      // 封面最后一个有内容的段落挂载独立 sectPr (vAlign=center + nextPage)
      let coverLastP: any = null
      for (let i = 0; i < body.childNodes.length; i++) {
        const node = body.childNodes[i]
        if (node === tocSdt) break
        if (node.nodeType === 1 && (node.localName === "p" || node.nodeName.endsWith(":p"))) {
          const text = getTextContent(node).trim()
          const hasDrawing = findDescendantsByTag(node, "drawing").length > 0
          if (text || hasDrawing) {
            coverLastP = node
          }
        }
      }

      if (coverLastP) {
        let cpPPr = findFirstChild(coverLastP, "pPr")
        if (!cpPPr) {
          cpPPr = doc.createElementNS(W_NS, "w:pPr")
          coverLastP.insertBefore(cpPPr, coverLastP.firstChild)
        }
        let cpSectPr = findFirstChild(cpPPr, "sectPr")
        if (!cpSectPr) {
          cpSectPr = doc.createElementNS(W_NS, "w:sectPr")
          cpPPr.appendChild(cpSectPr)
        }

        let pgMar = findFirstChild(cpSectPr, "pgMar")
        if (!pgMar) {
          pgMar = doc.createElementNS(W_NS, "w:pgMar")
          cpSectPr.appendChild(pgMar)
        }
        pgMar.setAttribute("w:top", theme.pageMarginTop)
        pgMar.setAttribute("w:bottom", theme.pageMarginBottom)
        pgMar.setAttribute("w:left", theme.pageMarginLeft)
        pgMar.setAttribute("w:right", theme.pageMarginRight)

        let vAlign = findFirstChild(cpSectPr, "vAlign")
        if (!vAlign) {
          vAlign = doc.createElementNS(W_NS, "w:vAlign")
          cpSectPr.appendChild(vAlign)
        }
        vAlign.setAttribute("w:val", "center")

        let sectType = findFirstChild(cpSectPr, "type")
        if (!sectType) {
          sectType = doc.createElementNS(W_NS, "w:type")
          cpSectPr.appendChild(sectType)
        }
        sectType.setAttribute("w:val", "nextPage")
      }
    }

    // === 3. 标题排版与字号字体注入 ===
    let totalH1 = 0
    let totalH2 = 0
    const paragraphs = findDescendantsByTag(body, "p")
    for (const p of paragraphs) {
      const style = getStyleVal(p)
      if (style === "Heading1") totalH1++
      else if (style === "Heading2") totalH2++
    }

    const compactMode = totalH2 > 15

    let h1Count = 0
    for (const p of paragraphs) {
      const style = getStyleVal(p)
      if (style === "Heading1") {
        h1Count++
        let pPr = findFirstChild(p, "pPr")
        if (!pPr) {
          pPr = doc.createElementNS(W_NS, "w:pPr")
          p.insertBefore(pPr, p.firstChild)
        }
        if (!compactMode) {
          let jc = findFirstChild(pPr, "jc")
          if (!jc) {
            jc = doc.createElementNS(W_NS, "w:jc")
            pPr.appendChild(jc)
          }
          jc.setAttribute("w:val", theme.h1Align)
        }
        if (h1Count > 1 && theme.heading1PageBreak) {
          let pageBreak = findFirstChild(pPr, "pageBreakBefore")
          if (!pageBreak) {
            pageBreak = doc.createElementNS(W_NS, "w:pageBreakBefore")
            pPr.appendChild(pageBreak)
          }
        }

        // 标题颜色与字体
        const runs = findDescendantsByTag(p, "r")
        for (const r of runs) {
          let rPr = findFirstChild(r, "rPr")
          if (!rPr) {
            rPr = doc.createElementNS(W_NS, "w:rPr")
            r.insertBefore(rPr, r.firstChild)
          }
          let color = findFirstChild(rPr, "color")
          if (!color) {
            color = doc.createElementNS(W_NS, "w:color")
            rPr.appendChild(color)
          }
          color.setAttribute("w:val", theme.h1Color)

          let rFonts = findFirstChild(rPr, "rFonts")
          if (!rFonts) {
            rFonts = doc.createElementNS(W_NS, "w:rFonts")
            rPr.appendChild(rFonts)
          }
          rFonts.setAttribute("w:ascii", theme.fontHeadingAscii)
          rFonts.setAttribute("w:hAnsi", theme.fontHeadingAscii)
          rFonts.setAttribute("w:eastAsia", theme.fontHeadingEastAsia)
          rFonts.setAttribute("w:cs", theme.fontHeadingAscii)

          let sz = findFirstChild(rPr, "sz")
          if (!sz) {
            sz = doc.createElementNS(W_NS, "w:sz")
            rPr.appendChild(sz)
          }
          sz.setAttribute("w:val", theme.fontH1SizeHalfPt)
        }
      } else if (style === "Heading2") {
        let pPr = findFirstChild(p, "pPr")
        if (!pPr) {
          pPr = doc.createElementNS(W_NS, "w:pPr")
          p.insertBefore(pPr, p.firstChild)
        }
        if (!compactMode && theme.heading2PageBreak) {
          let pageBreak = findFirstChild(pPr, "pageBreakBefore")
          if (!pageBreak) {
            pageBreak = doc.createElementNS(W_NS, "w:pageBreakBefore")
            pPr.appendChild(pageBreak)
          }
        }
        const runs = findDescendantsByTag(p, "r")
        for (const r of runs) {
          let rPr = findFirstChild(r, "rPr")
          if (!rPr) {
            rPr = doc.createElementNS(W_NS, "w:rPr")
            r.insertBefore(rPr, r.firstChild)
          }
          let color = findFirstChild(rPr, "color")
          if (!color) {
            color = doc.createElementNS(W_NS, "w:color")
            rPr.appendChild(color)
          }
          color.setAttribute("w:val", theme.h2Color)

          let rFonts = findFirstChild(rPr, "rFonts")
          if (!rFonts) {
            rFonts = doc.createElementNS(W_NS, "w:rFonts")
            rPr.appendChild(rFonts)
          }
          rFonts.setAttribute("w:ascii", theme.fontHeadingAscii)
          rFonts.setAttribute("w:hAnsi", theme.fontHeadingAscii)
          rFonts.setAttribute("w:eastAsia", theme.fontHeadingEastAsia)
          rFonts.setAttribute("w:cs", theme.fontHeadingAscii)

          let sz = findFirstChild(rPr, "sz")
          if (!sz) {
            sz = doc.createElementNS(W_NS, "w:sz")
            rPr.appendChild(sz)
          }
          sz.setAttribute("w:val", theme.fontH2SizeHalfPt)
        }
      } else if (style === "Heading3") {
        const runs = findDescendantsByTag(p, "r")
        for (const r of runs) {
          let rPr = findFirstChild(r, "rPr")
          if (!rPr) {
            rPr = doc.createElementNS(W_NS, "w:rPr")
            r.insertBefore(rPr, r.firstChild)
          }
          let color = findFirstChild(rPr, "color")
          if (!color) {
            color = doc.createElementNS(W_NS, "w:color")
            rPr.appendChild(color)
          }
          color.setAttribute("w:val", theme.h3Color)

          let rFonts = findFirstChild(rPr, "rFonts")
          if (!rFonts) {
            rFonts = doc.createElementNS(W_NS, "w:rFonts")
            rPr.appendChild(rFonts)
          }
          rFonts.setAttribute("w:ascii", theme.fontHeadingAscii)
          rFonts.setAttribute("w:hAnsi", theme.fontHeadingAscii)
          rFonts.setAttribute("w:eastAsia", theme.fontHeadingEastAsia)
          rFonts.setAttribute("w:cs", theme.fontHeadingAscii)

          let sz = findFirstChild(rPr, "sz")
          if (!sz) {
            sz = doc.createElementNS(W_NS, "w:sz")
            rPr.appendChild(sz)
          }
          sz.setAttribute("w:val", theme.fontH3SizeHalfPt)
        }
      }
    }

    // === 4. 深度美化表格（满宽自适应、表头底纹、斑马纹、边框与行高） ===
    const tables = findDescendantsByTag(body, "tbl")
    for (const tbl of tables) {
      let tblPr = findFirstChild(tbl, "tblPr")
      if (!tblPr) {
        tblPr = doc.createElementNS(W_NS, "w:tblPr")
        tbl.insertBefore(tblPr, tbl.firstChild)
      }

      // 满宽与对齐
      let tblW = findFirstChild(tblPr, "tblW")
      if (!tblW) {
        tblW = doc.createElementNS(W_NS, "w:tblW")
        tblPr.appendChild(tblW)
      }
      tblW.setAttribute("w:w", theme.tableWidthPct)
      tblW.setAttribute("w:type", "pct")

      let jc = findFirstChild(tblPr, "jc")
      if (!jc) {
        jc = doc.createElementNS(W_NS, "w:jc")
        tblPr.appendChild(jc)
      }
      jc.setAttribute("w:val", theme.tableAlign)

      // 专业边框
      let tblBorders = findFirstChild(tblPr, "tblBorders")
      if (!tblBorders) {
        tblBorders = doc.createElementNS(W_NS, "w:tblBorders")
        tblPr.appendChild(tblBorders)
      }
      for (const bname of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
        let b = findFirstChild(tblBorders, bname)
        if (!b) {
          b = doc.createElementNS(W_NS, `w:${bname}`)
          tblBorders.appendChild(b)
        }
        b.setAttribute("w:val", "single")
        b.setAttribute("w:sz", theme.tableBorderSize)
        b.setAttribute("w:space", "0")
        b.setAttribute("w:color", theme.tableBorderColor)
      }

      // 统计各列最大字数，计算自适应列宽比例
      const rows = findChildrenByTag(tbl, "tr")
      const numCols = rows.length > 0 ? findChildrenByTag(rows[0], "tc").length : 0

      let colWidthTwips: number[] = []
      if (numCols > 0) {
        const colMaxChars: number[] = new Array(numCols).fill(1)
        for (const row of rows) {
          const cells = findChildrenByTag(row, "tc")
          for (let ci = 0; ci < cells.length && ci < numCols; ci++) {
            const cellText = getTextContent(cells[ci]).trim()
            const w = getCjkStringWidth(cellText)
            if (w > colMaxChars[ci]) colMaxChars[ci] = w
          }
        }

        const totalWidth = theme.pageContentWidthTwips
        const minColTwips = theme.tableMinColWidth

        // 识别短文本列 (max CJK 宽度 <= 24，即 12 个汉字以内，如层级、状态、周期、编号、类型等)
        // 为短列预留足够的不折行安全物理宽度：每半角字符 125 twips (汉字 250 twips) + 左右缓冲边距 360 twips
        const idealWidths = colMaxChars.map((c) => {
          const needed = Math.round(c * 125) + 360
          return Math.max(minColTwips, needed)
        })

        const isShortCol = colMaxChars.map((c) => c <= 24)
        const shortTotalIdeal = idealWidths.reduce((sum, w, i) => sum + (isShortCol[i] ? w : 0), 0)
        const longColsCount = isShortCol.filter((s) => !s).length

        colWidthTwips = new Array(numCols).fill(0)

        if (longColsCount === 0 || shortTotalIdeal >= totalWidth - longColsCount * minColTwips) {
          // 全部是短列或总宽度紧张：按比例弹性缩放
          const totalIdeal = idealWidths.reduce((a, b) => a + b, 0) || 1
          colWidthTwips = idealWidths.map((w) => Math.max(minColTwips, Math.round((w / totalIdeal) * totalWidth)))
        } else {
          // 存在长文本列：优先完全保证短列的不换行安全宽度，剩余空间按字数比例分给长列
          for (let i = 0; i < numCols; i++) {
            if (isShortCol[i]) {
              colWidthTwips[i] = idealWidths[i]
            }
          }
          const remainingWidth = totalWidth - shortTotalIdeal
          const longTotalChars = colMaxChars.reduce((sum, c, i) => sum + (!isShortCol[i] ? c : 0), 0) || 1
          for (let i = 0; i < numCols; i++) {
            if (!isShortCol[i]) {
              colWidthTwips[i] = Math.max(minColTwips, Math.round((colMaxChars[i] / longTotalChars) * remainingWidth))
            }
          }
        }

        // 精确修正总宽度误差
        const currentSum = colWidthTwips.reduce((a, b) => a + b, 0)
        if (currentSum !== totalWidth && colWidthTwips.length > 0) {
          colWidthTwips[colWidthTwips.length - 1] += totalWidth - currentSum
        }

        // 插入 tblGrid
        let tblGrid = findFirstChild(tbl, "tblGrid")
        if (!tblGrid) {
          tblGrid = doc.createElementNS(W_NS, "w:tblGrid")
          tbl.insertBefore(tblGrid, tblPr.nextSibling)
        } else {
          while (tblGrid.firstChild) {
            tblGrid.removeChild(tblGrid.firstChild)
          }
        }
        for (const w of colWidthTwips) {
          const gridCol = doc.createElementNS(W_NS, "w:gridCol")
          gridCol.setAttribute("w:w", String(w))
          tblGrid.appendChild(gridCol)
        }
      }

      // 逐行设置高度与表头底纹
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri]
        let trPr = findFirstChild(row, "trPr")
        if (!trPr) {
          trPr = doc.createElementNS(W_NS, "w:trPr")
          row.insertBefore(trPr, row.firstChild)
        }
        let trHeight = findFirstChild(trPr, "trHeight")
        if (!trHeight) {
          trHeight = doc.createElementNS(W_NS, "w:trHeight")
          trPr.appendChild(trHeight)
        }
        trHeight.setAttribute("w:val", ri === 0 ? theme.tableHeaderHeight : theme.tableRowHeight)
        trHeight.setAttribute("w:hRule", "atLeast")

        if (ri === 0) {
          let tblHeader = findFirstChild(trPr, "tblHeader")
          if (!tblHeader) {
            tblHeader = doc.createElementNS(W_NS, "w:tblHeader")
            trPr.appendChild(tblHeader)
          }
        }

        const cells = findChildrenByTag(row, "tc")
        for (let ci = 0; ci < cells.length; ci++) {
          const tc = cells[ci]
          let tcPr = findFirstChild(tc, "tcPr")
          if (!tcPr) {
            tcPr = doc.createElementNS(W_NS, "w:tcPr")
            tc.insertBefore(tcPr, tc.firstChild)
          }

          // 显式为每个单元格设置准确的 dxa 宽度，防止 Word 自动布局挤压短列
          if (ci < colWidthTwips.length) {
            let tcW = findFirstChild(tcPr, "tcW")
            if (!tcW) {
              tcW = doc.createElementNS(W_NS, "w:tcW")
              tcPr.appendChild(tcW)
            }
            tcW.setAttribute("w:w", String(colWidthTwips[ci]))
            tcW.setAttribute("w:type", "dxa")
          }

          let vAlign = findFirstChild(tcPr, "vAlign")
          if (!vAlign) {
            vAlign = doc.createElementNS(W_NS, "w:vAlign")
            tcPr.appendChild(vAlign)
          }
          vAlign.setAttribute("w:val", theme.tableCellVAlign)

          if (ri === 0) {
            let noWrap = findFirstChild(tcPr, "noWrap")
            if (!noWrap) {
              noWrap = doc.createElementNS(W_NS, "w:noWrap")
              tcPr.appendChild(noWrap)
            }

            let shd = findFirstChild(tcPr, "shd")
            if (!shd) {
              shd = doc.createElementNS(W_NS, "w:shd")
              tcPr.appendChild(shd)
            }
            shd.setAttribute("w:val", "clear")
            shd.setAttribute("w:color", "auto")
            shd.setAttribute("w:fill", theme.primaryColor)

            const runs = findDescendantsByTag(tc, "r")
            for (const r of runs) {
              let rPr = findFirstChild(r, "rPr")
              if (!rPr) {
                rPr = doc.createElementNS(W_NS, "w:rPr")
                r.insertBefore(rPr, r.firstChild)
              }
              let b = findFirstChild(rPr, "b")
              if (!b) {
                b = doc.createElementNS(W_NS, "w:b")
                rPr.appendChild(b)
              }
              let color = findFirstChild(rPr, "color")
              if (!color) {
                color = doc.createElementNS(W_NS, "w:color")
                rPr.appendChild(color)
              }
              color.setAttribute("w:val", theme.headerTextColor)

              let rFonts = findFirstChild(rPr, "rFonts")
              if (!rFonts) {
                rFonts = doc.createElementNS(W_NS, "w:rFonts")
                rPr.appendChild(rFonts)
              }
              rFonts.setAttribute("w:ascii", theme.fontHeadingAscii)
              rFonts.setAttribute("w:hAnsi", theme.fontHeadingAscii)
              rFonts.setAttribute("w:eastAsia", theme.fontHeadingEastAsia)
              rFonts.setAttribute("w:cs", theme.fontHeadingAscii)
            }
          } else {
            // 短单元格（<= 12 个中文字符 / 24 CJK 宽度且无换行）防自动折行掉行
            const cellText = getTextContent(tc).trim()
            const hasLineBreak = cellText.includes("\n") || findDescendantsByTag(tc, "br").length > 0
            if (!hasLineBreak && cellText.length > 0 && getCjkStringWidth(cellText) <= 24) {
              let noWrap = findFirstChild(tcPr, "noWrap")
              if (!noWrap) {
                noWrap = doc.createElementNS(W_NS, "w:noWrap")
                tcPr.appendChild(noWrap)
              }
            }

            // 数据行：偶数行应用斑马纹浅底色
            if (ri % 2 === 0 && theme.tableStripeBg) {
              let shd = findFirstChild(tcPr, "shd")
              if (!shd) {
                shd = doc.createElementNS(W_NS, "w:shd")
                tcPr.appendChild(shd)
              }
              shd.setAttribute("w:val", "clear")
              shd.setAttribute("w:color", "auto")
              shd.setAttribute("w:fill", theme.tableStripeBg)
            }

            const runs = findDescendantsByTag(tc, "r")
            for (const r of runs) {
              let rPr = findFirstChild(r, "rPr")
              if (!rPr) {
                rPr = doc.createElementNS(W_NS, "w:rPr")
                r.insertBefore(rPr, r.firstChild)
              }
              let rFonts = findFirstChild(rPr, "rFonts")
              if (!rFonts) {
                rFonts = doc.createElementNS(W_NS, "w:rFonts")
                rPr.appendChild(rFonts)
              }
              rFonts.setAttribute("w:ascii", theme.fontBodyAscii)
              rFonts.setAttribute("w:hAnsi", theme.fontBodyAscii)
              rFonts.setAttribute("w:eastAsia", theme.fontBodyEastAsia)
              rFonts.setAttribute("w:cs", theme.fontBodyAscii)

              let sz = findFirstChild(rPr, "sz")
              if (!sz) {
                sz = doc.createElementNS(W_NS, "w:sz")
                rPr.appendChild(sz)
              }
              sz.setAttribute("w:val", theme.fontBodySizeHalfPt)

              let color = findFirstChild(rPr, "color")
              if (!color) {
                color = doc.createElementNS(W_NS, "w:color")
                rPr.appendChild(color)
              }
              color.setAttribute("w:val", theme.textMainColor)
            }
          }
          // 重置单元格内所有段落的段前/段后间距为 0，防止默认段落间距撑大行高
          const cellPs = findChildrenByTag(tc, "p")
          for (const cp of cellPs) {
            let cpPr = findFirstChild(cp, "pPr")
            if (!cpPr) {
              cpPr = doc.createElementNS(W_NS, "w:pPr")
              cp.insertBefore(cpPr, cp.firstChild)
            }
            let spacing = findFirstChild(cpPr, "spacing")
            if (!spacing) {
              spacing = doc.createElementNS(W_NS, "w:spacing")
              cpPr.appendChild(spacing)
            }
            spacing.setAttribute("w:before", "0")
            spacing.setAttribute("w:after", "0")
            spacing.setAttribute("w:line", "240")
            spacing.setAttribute("w:lineRule", "auto")
          }
        }
      }
    }

    // === 5. 代码块排版美化（等宽字体、背景色、细边框、间距） ===
    for (const p of paragraphs) {
      if (getStyleVal(p) === "SourceCode") {
        let pPr = findFirstChild(p, "pPr")
        if (!pPr) {
          pPr = doc.createElementNS(W_NS, "w:pPr")
          p.insertBefore(pPr, p.firstChild)
        }

        let shd = findFirstChild(pPr, "shd")
        if (!shd) {
          shd = doc.createElementNS(W_NS, "w:shd")
          pPr.appendChild(shd)
        }
        shd.setAttribute("w:val", "clear")
        shd.setAttribute("w:color", "auto")
        shd.setAttribute("w:fill", theme.codeBg)

        let pBdr = findFirstChild(pPr, "pBdr")
        if (!pBdr) {
          pBdr = doc.createElementNS(W_NS, "w:pBdr")
          pPr.appendChild(pBdr)
        }
        for (const bname of ["top", "left", "bottom", "right"]) {
          let b = findFirstChild(pBdr, bname)
          if (!b) {
            b = doc.createElementNS(W_NS, `w:${bname}`)
            pBdr.appendChild(b)
          }
          b.setAttribute("w:val", "single")
          b.setAttribute("w:sz", theme.codeBorderSize)
          b.setAttribute("w:space", theme.codeBorderSpace)
          b.setAttribute("w:color", theme.codeBorderColor)
        }

        let spacing = findFirstChild(pPr, "spacing")
        if (!spacing) {
          spacing = doc.createElementNS(W_NS, "w:spacing")
          pPr.appendChild(spacing)
        }
        spacing.setAttribute("w:line", theme.codeLineSpacing)
        spacing.setAttribute("w:lineRule", "auto")

        const runs = findDescendantsByTag(p, "r")
        for (const r of runs) {
          let rPr = findFirstChild(r, "rPr")
          if (!rPr) {
            rPr = doc.createElementNS(W_NS, "w:rPr")
            r.insertBefore(rPr, r.firstChild)
          }
          let rFonts = findFirstChild(rPr, "rFonts")
          if (!rFonts) {
            rFonts = doc.createElementNS(W_NS, "w:rFonts")
            rPr.appendChild(rFonts)
          }
          rFonts.setAttribute("w:ascii", theme.fontCodeAscii)
          rFonts.setAttribute("w:hAnsi", theme.fontCodeAscii)
          rFonts.setAttribute("w:eastAsia", theme.fontCodeEastAsia)
          rFonts.setAttribute("w:cs", theme.fontCodeAscii)

          let sz = findFirstChild(rPr, "sz")
          if (!sz) {
            sz = doc.createElementNS(W_NS, "w:sz")
            rPr.appendChild(sz)
          }
          sz.setAttribute("w:val", theme.codeFontSizeHalfPt)

          let color = findFirstChild(rPr, "color")
          if (!color) {
            color = doc.createElementNS(W_NS, "w:color")
            rPr.appendChild(color)
          }
          color.setAttribute("w:val", theme.codeTextColor)
        }
      }
    }

    // === 6. 连续下划线清洗为全角空格 ===
    if (theme.cleanUnderlines) {
      const allTexts = findDescendantsByTag(body, "t")
      for (const t of allTexts) {
        if (t.textContent && /_{4,}/.test(t.textContent)) {
          t.textContent = t.textContent.replace(/_{4,}/g, (m: string) => "　".repeat(m.length))
        }
      }
    }

    // === 7. 清理 TOC 后的多余空段落 ===
    if (tocSdt) {
      let pastToc = false
      for (let index = 0; index < body.childNodes.length; index++) {
        const node = body.childNodes[index]
        if (node === tocSdt) {
          pastToc = true
          continue
        }
        if (!pastToc) continue
        if (node.nodeType === 1 && (node.localName === "p" || node.nodeName.endsWith(":p"))) {
          const text = getTextContent(node).trim()
          const hasDrawing = findDescendantsByTag(node, "drawing").length > 0
          const pPr = findFirstChild(node, "pPr")
          const hasSectPr = pPr && findFirstChild(pPr, "sectPr")

          if (!text && !hasDrawing && !hasSectPr) {
            body.removeChild(node)
          }
        }
      }
    }

    // === 8. 注入 styles.xml 默认正文字体与字号 (SimSun + Times New Roman 纤细标准) ===
    const stylesEntry = zip.getEntry("word/styles.xml")
    if (stylesEntry) {
      try {
        const stylesXmlStr = zip.readAsText(stylesEntry, "utf8")
        const stylesDoc = parser.parseFromString(stylesXmlStr, "text/xml")
        const stylesElem = stylesDoc.documentElement

        // 1) docDefaults
        const docDefaults = findFirstChild(stylesElem, "docDefaults")
        if (docDefaults) {
          const rPrDefault = findFirstChild(docDefaults, "rPrDefault")
          if (rPrDefault) {
            let defRPr = findFirstChild(rPrDefault, "rPr")
            if (!defRPr) {
              defRPr = stylesDoc.createElementNS(W_NS, "w:rPr")
              rPrDefault.appendChild(defRPr)
            }
            let defFonts = findFirstChild(defRPr, "rFonts")
            if (!defFonts) {
              defFonts = stylesDoc.createElementNS(W_NS, "w:rFonts")
              defRPr.appendChild(defFonts)
            }
            defFonts.setAttribute("w:ascii", theme.fontBodyAscii)
            defFonts.setAttribute("w:hAnsi", theme.fontBodyAscii)
            defFonts.setAttribute("w:eastAsia", theme.fontBodyEastAsia)
            defFonts.setAttribute("w:cs", theme.fontBodyAscii)

            let defSz = findFirstChild(defRPr, "sz")
            if (!defSz) {
              defSz = stylesDoc.createElementNS(W_NS, "w:sz")
              defRPr.appendChild(defSz)
            }
            defSz.setAttribute("w:val", theme.fontBodySizeHalfPt)
          }
        }

        // 2) Normal style
        const allStyles = findChildrenByTag(stylesElem, "style")
        for (const s of allStyles) {
          const styleId = s.getAttribute("w:styleId") || s.getAttribute("styleId")
          if (styleId === "Normal" || styleId === "BodyText") {
            let sRPr = findFirstChild(s, "rPr")
            if (!sRPr) {
              sRPr = stylesDoc.createElementNS(W_NS, "w:rPr")
              s.appendChild(sRPr)
            }
            let sFonts = findFirstChild(sRPr, "rFonts")
            if (!sFonts) {
              sFonts = stylesDoc.createElementNS(W_NS, "w:rFonts")
              sRPr.appendChild(sFonts)
            }
            sFonts.setAttribute("w:ascii", theme.fontBodyAscii)
            sFonts.setAttribute("w:hAnsi", theme.fontBodyAscii)
            sFonts.setAttribute("w:eastAsia", theme.fontBodyEastAsia)
            sFonts.setAttribute("w:cs", theme.fontBodyAscii)

            let sSz = findFirstChild(sRPr, "sz")
            if (!sSz) {
              sSz = stylesDoc.createElementNS(W_NS, "w:sz")
              sRPr.appendChild(sSz)
            }
            sSz.setAttribute("w:val", theme.fontBodySizeHalfPt)

            let b = findFirstChild(sRPr, "b")
            if (b) {
              sRPr.removeChild(b)
            }
          }
        }

        const stylesSerializer = new XMLSerializer()
        const updatedStylesXml = stylesSerializer.serializeToString(stylesDoc)
        zip.updateFile("word/styles.xml", Buffer.from(updatedStylesXml, "utf8"))
      } catch {}
    }

    // === 9. 图片与图表智能尺寸与居中校准 (大图舒展、高清居中) ===
    const maxEmuWidth = theme.pageContentWidthTwips * 635
    const drawings = findDescendantsByTag(body, "drawing")
    for (const d of drawings) {
      let parent = d.parentNode
      while (parent && parent !== body) {
        if (parent.nodeType === 1 && (parent.localName === "p" || parent.nodeName.endsWith(":p"))) {
          let pPr = findFirstChild(parent, "pPr")
          if (!pPr) {
            pPr = doc.createElementNS(W_NS, "w:pPr")
            parent.insertBefore(pPr, parent.firstChild)
          }
          let jc = findFirstChild(pPr, "jc")
          if (!jc) {
            jc = doc.createElementNS(W_NS, "w:jc")
            pPr.appendChild(jc)
          }
          jc.setAttribute("w:val", "center")
          break
        }
        parent = parent.parentNode
      }

      // 将图片/图表自动扩展至 100% 页面满版心宽度，等比例缩放高度
      const extents = findDescendantsByTag(d, "extent")
      const xfrms = findDescendantsByTag(d, "ext")
      for (const ext of [...extents, ...xfrms]) {
        const cx = parseInt(ext.getAttribute("cx") || "0", 10)
        const cy = parseInt(ext.getAttribute("cy") || "0", 10)
        if (cx > 0 && cy > 0) {
          const ratio = cx / cy
          const targetCx = maxEmuWidth // 100% 满版心宽度 (约 14.63cm)
          const targetCy = Math.round(targetCx / ratio)
          ext.setAttribute("cx", String(targetCx))
          ext.setAttribute("cy", String(targetCy))
        }
      }
    }

    // 重新写入 docx
    const serializer = new XMLSerializer()
    const updatedXmlStr = serializer.serializeToString(doc)
    zip.updateFile("word/document.xml", Buffer.from(updatedXmlStr, "utf8"))
    zip.writeZip(docxPath)
    return true
  } catch (err) {
    console.warn("[DocxPostProcess] Warning during DOCX OpenXML beautification:", (err as Error).message)
    return false
  }
}
