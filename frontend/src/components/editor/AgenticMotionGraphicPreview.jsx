import { memo } from 'react'

// Browser counterpart of StoryForge's AgenticMotionGraphic renderer. Keep the
// design canvas at the renderer's native 1920x1080 geometry and let SVG scale
// the complete frame as one unit. Responsive reflow was the source of the old
// Editor/render mismatch (large statistics overlapped headings and comparison
// cards changed shape).
export const AGENTIC_GRAPHIC_CONTRACT = 'agentic-motion-graphic-v2'

const DISPLAY = "'Cormorant Garamond', Georgia, serif"
const SANS = "Inter, ui-sans-serif, system-ui, sans-serif"
const tempoFactor = { contemplative: 1.28, measured: 1, energetic: 0.78, urgent: 0.64 }
const clamp = value => Math.max(0, Math.min(1, value))
// Remotion uses Easing.bezier(.22, 1, .36, 1). Solve the same curve here so
// editor entry/exit timing stays frame-identical instead of merely similar.
const ease = value => {
  const target = clamp(value)
  let parameter = target
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const inverse = 1 - parameter
    const x = (3 * inverse * inverse * parameter * .22)
      + (3 * inverse * parameter * parameter * .36)
      + (parameter ** 3)
    const derivative = (3 * inverse * inverse * .22)
      + (6 * inverse * parameter * (.36 - .22))
      + (3 * parameter * parameter * (1 - .36))
    if (Math.abs(derivative) < 1e-7) break
    parameter = clamp(parameter - ((x - target) / derivative))
  }
  const inverse = 1 - parameter
  return (3 * inverse * inverse * parameter)
    + (3 * inverse * parameter * parameter)
    + (parameter ** 3)
}
const reveal = (frame, start, duration = 20) => ease((frame - start) / Math.max(1, duration))

function repeatedPrimaryCopy(content) {
  if (!content.primary_value || (!content.body && !content.title)) return false
  const normalize = value => String(value || '')
    .toLowerCase().replace(/[–—-]/g, ' ').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean)
  const copy = normalize(`${content.title || ''} ${content.body || ''}`)
  const label = normalize(content.primary_label)
  const numeric = String(content.primary_value).match(/\d+/)?.[0]
  return (!!numeric && copy.includes(numeric))
    || (label.length > 0 && label.filter(token => copy.includes(token)).length / label.length >= 0.65)
}

function Surface({ children, style, accent }) {
  return (
    <div style={{
      background: 'linear-gradient(145deg, rgba(20,24,31,.72), rgba(8,10,14,.54))',
      border: '1px solid rgba(245,241,232,.19)',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
      boxShadow: '0 28px 86px rgba(0,0,0,.31), inset 0 1px 0 rgba(255,255,255,.035)',
      backdropFilter: 'blur(26px) saturate(.82)',
      WebkitBackdropFilter: 'blur(26px) saturate(.82)',
      borderRadius: 18,
      ...style,
    }}>
      {children}
    </div>
  )
}

function Header({ content, accent, frame, align = 'left' }) {
  const p = reveal(frame, 4, 24)
  return (
    <div style={{ opacity: p, transform: `translateY(${(1 - p) * 18}px)`, textAlign: align }}>
      {content.eyebrow && <div style={{ color: accent, fontSize: 15, letterSpacing: '.2em', textTransform: 'uppercase', fontWeight: 600 }}>{content.eyebrow}</div>}
      {content.title && <div style={{ fontFamily: DISPLAY, fontSize: 68, lineHeight: 1.02, marginTop: 14, textWrap: 'balance' }}>{content.title}</div>}
      {content.body && <div style={{ marginTop: 22, maxWidth: 780, fontFamily: DISPLAY, fontSize: 27, lineHeight: 1.42, color: 'rgba(245,241,232,.62)' }}>{content.body}</div>}
    </div>
  )
}

function ElementCard({ element, index, frame, step, startFrame, accent, compact = false }) {
  const p = reveal(frame, startFrame ?? (28 + index * step), compact ? 15 : 20)
  const color = element.accent || accent
  return (
    <Surface accent={color} style={{
      padding: compact ? '20px 24px' : '28px 32px', opacity: p,
      transform: `translateY(${(1 - p) * 22}px) scale(${0.98 + p * 0.02})`, minWidth: 0,
    }}>
      {(element.value || element.title) && <div style={{
        fontFamily: element.value ? DISPLAY : SANS,
        fontSize: element.value ? (compact ? 38 : 58) : (compact ? 18 : 23),
        lineHeight: 1, color: element.value ? '#fff' : color,
        letterSpacing: element.value ? '.01em' : '.08em',
        textTransform: element.value ? undefined : 'uppercase',
      }}>{element.value || element.title}</div>}
      {(element.label || (element.value && element.title)) && <div style={{ marginTop: 9, fontSize: compact ? 13 : 16, color: 'rgba(245,241,232,.68)' }}>{element.label || element.title}</div>}
      {element.body && <div style={{ marginTop: 11, fontFamily: DISPLAY, fontSize: compact ? 18 : 22, lineHeight: 1.35, color: 'rgba(245,241,232,.52)' }}>{element.body}</div>}
    </Surface>
  )
}

function Background({ mode, opacity, accent, secondary, presentation, frame }) {
  const drift = Math.sin(frame / 68) * 18
  const baseOpacity = presentation === 'takeover' ? 1 : opacity
  const backgrounds = {
    'footage-dim': `radial-gradient(circle at 76% 24%, ${secondary}22, transparent 30%), linear-gradient(105deg, rgba(3,5,9,.92), rgba(5,8,13,${Math.max(.1, baseOpacity * .8)}) 48%, rgba(3,5,9,.48))`,
    'editorial-gradient': `radial-gradient(circle at 18% 18%, ${accent}28, transparent 30%), radial-gradient(circle at 82% 76%, ${secondary}24, transparent 34%), linear-gradient(125deg, #101722 0%, #080a0f 48%, #151018 100%)`,
    'archival-paper': `linear-gradient(120deg, rgba(15,12,9,.96), rgba(37,31,24,.92)), radial-gradient(circle at 24% 20%, ${accent}1f, transparent 36%)`,
    'technical-grid': `radial-gradient(circle at 72% 24%, ${secondary}24, transparent 30%), linear-gradient(140deg, #071116, #080b10 58%, #111015)`,
    'soft-atmosphere': `radial-gradient(ellipse at 24% 26%, ${accent}2d, transparent 38%), radial-gradient(ellipse at 78% 72%, ${secondary}24, transparent 42%), linear-gradient(135deg, #17151a, #090b10)`,
    'spatial-field': `radial-gradient(circle at 50% 44%, ${secondary}28, transparent 20%), radial-gradient(circle at 26% 64%, ${accent}20, transparent 32%), linear-gradient(145deg, #06090f, #0c1018 60%, #08080d)`,
  }
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: baseOpacity, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background: backgrounds[mode] || backgrounds['footage-dim'], transform: `translate3d(${drift}px, ${-drift * .35}px, 0) scale(1.04)` }} />
      {(mode === 'technical-grid' || mode === 'spatial-field') && <div style={{ position: 'absolute', inset: 0, opacity: .16, backgroundImage: 'linear-gradient(rgba(255,255,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px)', backgroundSize: mode === 'technical-grid' ? '74px 74px' : '110px 110px', maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 82%)' }} />}
      {mode === 'archival-paper' && <div style={{ position: 'absolute', inset: 0, opacity: .09, backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%270 0 140 140%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.16%27 numOctaves=%274%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E")' }} />}
      <div style={{ position: 'absolute', inset: 0, opacity: .035, backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%270 0 140 140%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.9%27 numOctaves=%273%27 stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27 opacity=%27.8%27/%3E%3C/svg%3E")' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,.56) 100%)' }} />
    </div>
  )
}

function GraphicBody({ spec, frame, fps, accent, secondary }) {
  const content = spec.composition?.content || {}
  const layout = spec.composition?.layout || {}
  const duplicatedPrimary = repeatedPrimaryCopy(content)
  const archetype = duplicatedPrimary ? 'minimal' : (layout.archetype || 'split')
  const elements = content.elements || []
  const reverse = !!layout.reverse_order || layout.focus_side === 'left'
  const tempo = spec.composition?.animation?.tempo || 'measured'
  const step = Math.max(10, Math.round(24 * (tempoFactor[tempo] || 1)))
  const beats = spec.composition?.animation?.beats || []
  const beatFrame = (index, element, fallback = 28 + index * step) => {
    const beat = beats.find(candidate => candidate.target === element?.id || candidate.target === `element-${index + 1}` || candidate.target === element?.role) || beats[index]
    return Number.isFinite(beat?.at_seconds) ? Math.max(0, Math.round(beat.at_seconds * fps)) : fallback
  }
  const primaryP = reveal(frame, 22, Math.round(25 * (tempoFactor[tempo] || 1)))

  if (archetype === 'minimal') {
    const cardP = reveal(frame, 14, Math.round(28 * (tempoFactor[tempo] || 1)))
    return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: layout.focus_side === 'right' ? 'flex-end' : 'flex-start' }}>
      <Surface accent={accent} style={{ width: 'min(780px, 58%)', padding: '48px 56px 44px', opacity: cardP, transform: `translateY(${(1 - cardP) * 22}px) scale(${.975 + cardP * .025})` }}>
        {content.eyebrow && <div style={{ color: accent, fontSize: 14, letterSpacing: '.2em', textTransform: 'uppercase', fontWeight: 600 }}>{content.eyebrow}</div>}
        {content.title && <div style={{ fontFamily: DISPLAY, fontSize: 54, lineHeight: 1.02, marginTop: content.eyebrow ? 13 : 0 }}>{content.title}</div>}
        {(content.primary_value || content.primary_label) && <div style={{ marginTop: 30, display: 'flex', alignItems: 'baseline', gap: 18, borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 24 }}>
          {content.primary_value && <span style={{ fontFamily: DISPLAY, fontSize: 100, lineHeight: .8, color: '#fff' }}>{content.primary_value}</span>}
          {content.primary_label && <span style={{ fontFamily: DISPLAY, fontSize: 26, lineHeight: 1.12, color: accent, maxWidth: 340 }}>{content.primary_label}</span>}
        </div>}
        {content.body && !duplicatedPrimary && <div style={{ marginTop: 24, fontFamily: DISPLAY, fontSize: 24, lineHeight: 1.4, color: 'rgba(245,241,232,.58)' }}>{content.body}</div>}
        {elements.slice(0, 2).map((element, index) => <div key={element.id || index} style={{ marginTop: 18, opacity: reveal(frame, beatFrame(index, element, 54 + index * step), 16), color: 'rgba(245,241,232,.58)' }}><span style={{ color: element.accent || secondary, fontFamily: DISPLAY, fontSize: 24 }}>{element.value}</span><span style={{ marginLeft: 12, fontSize: 15 }}>{element.label || element.title}</span></div>)}
      </Surface>
    </div>
  }

  if (archetype === 'hero' || content.primary_value) {
    return <div style={{ height: '100%', display: 'grid', gridTemplateColumns: reverse ? '1.05fr .95fr' : '.95fr 1.05fr', gap: 62, alignItems: 'center' }}>
      <div style={{ order: reverse ? 2 : 1 }}><Header content={content} accent={accent} frame={frame} />{content.attribution && <div style={{ marginTop: 28, fontSize: 14, color: 'rgba(245,241,232,.4)', letterSpacing: '.08em' }}>{content.attribution}</div>}</div>
      <Surface accent={accent} style={{ order: reverse ? 1 : 2, padding: '54px 58px', opacity: primaryP, transform: `scale(${.96 + primaryP * .04})` }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 154, lineHeight: .86, color: '#fff' }}>{content.primary_value || elements[0]?.value}</div>
        <div style={{ marginTop: 24, fontFamily: DISPLAY, fontSize: 31, color: accent }}>{content.primary_label || elements[0]?.label}</div>
        {elements.slice(content.primary_value ? 0 : 1, 4).map((element, index) => <div key={element.id || index} style={{ display: 'flex', justifyContent: 'space-between', gap: 24, borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 16, marginTop: 16, opacity: reveal(frame, beatFrame(index, element, 54 + index * step), 16) }}><span style={{ color: 'rgba(245,241,232,.55)' }}>{element.label || element.title}</span><span style={{ fontFamily: DISPLAY, fontSize: 25, color: element.accent || secondary }}>{element.value}</span></div>)}
      </Surface>
    </div>
  }

  if (archetype === 'timeline' || archetype === 'sequence' || (archetype === 'comparison' && elements.length > 2)) {
    const cardColumns = elements.length > 1 ? 2 : 1
    return <div style={{ height: '100%', display: 'grid', gridTemplateColumns: reverse ? '1.08fr .92fr' : '.92fr 1.08fr', gap: 70, alignItems: 'center' }}>
      <div style={{ order: reverse ? 2 : 1, minWidth: 0 }}><Header content={content} accent={accent} frame={frame} /></div>
      <Surface style={{ order: reverse ? 1 : 2, padding: '44px 46px', opacity: reveal(frame, 16, Math.round(26 * (tempoFactor[tempo] || 1))), transform: `translateY(${(1 - reveal(frame, 16, Math.round(26 * (tempoFactor[tempo] || 1)))) * 18}px)` }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cardColumns}, minmax(0, 1fr))`, gap: 16 }}>
          {elements.slice(0, 6).map((element, index) => {
            const p = reveal(frame, beatFrame(index, element), 18)
            const color = element.accent || (index % 2 ? secondary : accent)
            const headline = element.value || element.title || element.label
            const supporting = element.value ? (element.label || element.title) : (element.title && element.label && element.title !== element.label ? element.label : element.body)
            return <div key={element.id || index} style={{ minWidth: 0, minHeight: 104, padding: '22px 24px', borderLeft: `3px solid ${color}`, background: 'rgba(245,241,232,.035)', opacity: p, transform: `translateY(${(1 - p) * 14}px)`, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontFamily: element.value ? DISPLAY : SANS, fontSize: element.value ? 38 : 17, lineHeight: element.value ? 1 : 1.28, letterSpacing: element.value ? '.01em' : '.08em', textTransform: element.value ? undefined : 'uppercase', color: element.value ? '#fff' : 'rgba(245,241,232,.78)', overflowWrap: 'anywhere' }}>{headline}</div>
              {supporting && <div style={{ marginTop: 9, fontSize: 13, lineHeight: 1.35, letterSpacing: '.04em', color: 'rgba(245,241,232,.55)', overflowWrap: 'anywhere' }}>{supporting}</div>}
            </div>
          })}
        </div>
      </Surface>
    </div>
  }

  if (archetype === 'network' || archetype === 'diagram' || archetype === 'spatial') {
    const count = Math.max(1, Math.min(7, elements.length))
    return <div style={{ height: '100%', display: 'grid', gridTemplateColumns: '.72fr 1.28fr', gap: 54, alignItems: 'center' }}>
      <Header content={content} accent={accent} frame={frame} />
      <Surface style={{ position: 'relative', height: 590, overflow: 'hidden' }}>
        <svg width="100%" height="100%" viewBox="0 0 920 590" style={{ position: 'absolute', inset: 0 }}>
          {elements.slice(1, count).map((_, index) => {
            const angle = (index / Math.max(1, count - 1)) * Math.PI * 2 - Math.PI / 2
            return <line key={index} x1="460" y1="295" x2={460 + Math.cos(angle) * 260} y2={295 + Math.sin(angle) * 190} stroke={index % 2 ? secondary : accent} strokeWidth="2" opacity={reveal(frame, 34 + index * 8, 34) * .6} />
          })}
        </svg>
        {elements.slice(0, count).map((element, index) => {
          const central = index === 0
          const angle = ((index - 1) / Math.max(1, count - 1)) * Math.PI * 2 - Math.PI / 2
          const x = central ? 50 : 50 + Math.cos(angle) * 32
          const y = central ? 50 : 50 + Math.sin(angle) * 33
          const p = reveal(frame, beatFrame(index, element, 24 + index * step), 18)
          const color = element.accent || (index % 2 ? secondary : accent)
          return <div key={element.id || index} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: `translate(-50%,-50%) scale(${.82 + p * .18})`, opacity: p, width: central ? 250 : 190, textAlign: 'center' }}>
            <div style={{ width: central ? 96 : 68, height: central ? 96 : 68, margin: '0 auto 12px', borderRadius: '50%', background: `${color}22`, border: `2px solid ${color}`, boxShadow: `0 0 30px ${element.accent || accent}33`, display: 'grid', placeItems: 'center', fontFamily: DISPLAY, fontSize: central ? 32 : 24 }}>{element.value || String(index + 1).padStart(2, '0')}</div>
            <div style={{ fontSize: central ? 17 : 14, letterSpacing: '.08em', textTransform: 'uppercase' }}>{element.title || element.label}</div>
          </div>
        })}
      </Surface>
    </div>
  }

  if (archetype === 'document') {
    return <div style={{ height: '100%', display: 'grid', gridTemplateColumns: reverse ? '1.05fr .95fr' : '.95fr 1.05fr', gap: 70, alignItems: 'center' }}>
      <Header content={content} accent={accent} frame={frame} />
      <Surface accent={accent} style={{ padding: '58px 66px', transform: `rotate(${reverse ? -1.4 : 1.4}deg)`, opacity: reveal(frame, 24, 28), background: 'linear-gradient(145deg, rgba(46,40,31,.82), rgba(20,18,15,.67))' }}><div style={{ fontFamily: DISPLAY, fontSize: 38, lineHeight: 1.4 }}>&ldquo;{elements[0]?.body || elements[0]?.title || content.body}&rdquo;</div><div style={{ width: 86, height: 2, background: accent, marginTop: 36 }} /><div style={{ marginTop: 18, color: 'rgba(245,241,232,.5)', letterSpacing: '.12em', textTransform: 'uppercase', fontSize: 13 }}>{content.attribution || elements[0]?.label}</div></Surface>
    </div>
  }

  const visible = elements.slice(0, archetype === 'comparison' ? 2 : 6)
  return <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', gap: 46 }}>
    <Header content={content} accent={accent} frame={frame} align={layout.focus_side === 'center' ? 'center' : 'left'} />
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${archetype === 'comparison' ? 2 : Math.min(3, Math.max(1, visible.length))}, 1fr)`, gap: 24, alignItems: 'stretch' }}>
      {visible.map((element, index) => <ElementCard key={element.id || index} element={element} index={index} frame={frame} step={step} startFrame={beatFrame(index, element)} accent={index % 2 ? secondary : accent} />)}
    </div>
  </div>
}

function AgenticMotionGraphicPreview({ spec, frame, durationInFrames, fps = 30 }) {
  const background = spec?.composition?.background || {}
  const layout = spec?.composition?.layout || {}
  const presentation = spec?.presentation || 'overlay'
  const accent = background.accent || '#d94b43'
  const secondary = background.secondary || '#58b7aa'
  const safeMargin = Math.max(4, Math.min(12, layout.safe_margin_percent || 6))
  const fadeIn = reveal(frame, 0, Math.min(18, Math.round(durationInFrames * .12)))
  const fadeDuration = Math.min(20, Math.round(durationInFrames * .14))
  const fadeOutStart = Math.max(0, durationInFrames - fadeDuration)
  const fadeOut = 1 - ease((frame - fadeOutStart) / Math.max(1, (durationInFrames - 1) - fadeOutStart))
  return (
    <svg data-renderer-contract={AGENTIC_GRAPHIC_CONTRACT} viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 w-full h-full">
      <foreignObject x="0" y="0" width="1920" height="1080">
        <div style={{ position: 'relative', width: 1920, height: 1080, color: '#f5f1e8', fontFamily: SANS, opacity: fadeIn * fadeOut, overflow: 'hidden' }}>
          <Background mode={background.mode || (presentation === 'takeover' ? 'editorial-gradient' : 'footage-dim')} opacity={background.opacity ?? (presentation === 'takeover' ? 1 : .68)} accent={accent} secondary={secondary} presentation={presentation} frame={frame} />
          <div style={{ position: 'absolute', inset: `${safeMargin}%`, zIndex: 2 }}><GraphicBody spec={spec || {}} frame={frame} fps={fps} accent={accent} secondary={secondary} /></div>
          <div style={{ position: 'absolute', left: `${safeMargin}%`, right: `${safeMargin}%`, bottom: 42, display: 'flex', justifyContent: 'space-between', color: 'rgba(245,241,232,.3)', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase' }}><span>{spec?.category || 'Editorial graphic'}</span><span>{spec?.source?.mode === 'invent' ? 'Original visual direction' : 'Director adaptation'}</span></div>
        </div>
      </foreignObject>
    </svg>
  )
}

export default memo(AgenticMotionGraphicPreview)
