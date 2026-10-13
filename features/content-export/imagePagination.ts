import { ContentExportError } from './errors';

export interface ImageSlice {
  readonly offset: number;
  readonly height: number;
}

/** Use measured gaps between lines/blocks; never allocate a whole-document bitmap. */
export function planImageSlices(
  height: number,
  boundaries: readonly number[],
  pageHeight: number,
): ImageSlice[] {
  if (
    !Number.isFinite(height) ||
    height <= 0 ||
    height > 200_000 ||
    !Number.isFinite(pageHeight) ||
    pageHeight < 100 ||
    pageHeight > 2_000
  )
    throw new ContentExportError('内容过长，无法生成长图，请改用 HTML 或 PDF');
  const points = [
    ...new Set(
      boundaries.filter(
        (point) => Number.isFinite(point) && point > 0 && point < height,
      ),
    ),
  ].sort((a, b) => a - b);
  const pages: ImageSlice[] = [];
  let offset = 0;
  while (offset < height) {
    const limit = Math.min(height, offset + pageHeight);
    let end = limit;
    if (limit < height) {
      const minimum = offset + pageHeight * 0.35;
      const candidates = points.filter(
        (point) => point >= minimum && point <= limit,
      );
      if (!candidates.length) {
        throw new ContentExportError(
          '存在无法安全分图的超高内容，请改用 HTML 或 PDF',
        );
      }
      end = Math.floor(candidates[candidates.length - 1]);
    }
    pages.push({ offset, height: Math.ceil(end - offset) });
    if (pages.length > 120)
      throw new ContentExportError('分图数量过多，请改用 HTML 或 PDF');
    offset = end;
  }
  return pages;
}

/** Injected only into our generated static document, never into a Zhihu page. */
export function imageMeasurementScript(pageHeight: number): string {
  return `(async function() {
    try {
      var style = document.createElement('style');
      style.textContent = 'html,body{margin:0!important;padding:0!important;overflow:hidden!important;} .export-document{margin:0!important;max-width:none!important;} img{max-height:${pageHeight - 48}px!important;object-fit:contain!important;}';
      document.head.appendChild(style);
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(async function(img) {
        if (!img.complete) await new Promise(function(resolve,reject) { img.onload=resolve; img.onerror=reject; });
        if (!img.naturalWidth) throw new Error('image');
        if (typeof img.decode === 'function') await img.decode();
      }));
      document.querySelectorAll('.katex').forEach(function(formula) {
        var parent = formula.closest('td,th,p,li,.block-formula') || formula.parentElement;
        var width = parent.clientWidth;
        var actual = Math.max(formula.scrollWidth, formula.getBoundingClientRect().width);
        if (width > 0 && actual > width) {
          var size = parseFloat(getComputedStyle(formula).fontSize) * width / actual;
          if (size < 8) throw new Error('formula');
          formula.style.fontSize = size + 'px';
        }
      });
      await new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(resolve);});});
      var article = document.querySelector('.export-document');
      if (!article) throw new Error('document');
      if (article.scrollWidth > document.documentElement.clientWidth + 2) throw new Error('overflow');
      var origin = article.getBoundingClientRect().top;
      var height = Math.ceil(article.getBoundingClientRect().height + origin);
      var intervals = [];
      var walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      var node;
      while ((node=walker.nextNode())) {
        if (!node.textContent.trim()) continue;
        var range = document.createRange(); range.selectNodeContents(node);
        Array.from(range.getClientRects()).forEach(function(rect) {
          if (rect.width>0 && rect.height>0) intervals.push([rect.top,rect.bottom]);
        });
      }
      article.querySelectorAll('img,.katex,tr').forEach(function(element) {
        var rect=element.getBoundingClientRect();
        if(rect.height>0 && rect.height<${pageHeight - 16}) intervals.push([rect.top,rect.bottom]);
      });
      intervals.sort(function(a,b){return a[0]-b[0];});
      var merged=[];
      intervals.forEach(function(item){
        var last=merged[merged.length-1];
        if(last && item[0]<=last[1]+1) last[1]=Math.max(last[1],item[1]);
        else merged.push(item.slice());
      });
      var boundaries=merged.slice(0,-1).map(function(item,i){return Math.floor((item[1]+merged[i+1][0])/2);});
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'measured',height:height,boundaries:boundaries}));
    } catch (_) {window.ReactNativeWebView.postMessage(JSON.stringify({type:'failed'}));}
  })(); true;`;
}

export function imagePositionScript(index: number, offset: number): string {
  return `(function(){
    document.querySelector('.export-document').style.transform='translateY(-${offset}px)';
    requestAnimationFrame(function(){requestAnimationFrame(function(){
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'positioned',index:${index}}));
    });});
  })(); true;`;
}
