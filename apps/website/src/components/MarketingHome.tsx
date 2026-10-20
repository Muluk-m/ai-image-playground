import { useEffect, useRef, useState } from 'react'
import { editions, type Locale } from '../catalog'
import {
  ASSET,
  caseHref,
  libraryRows,
  MARK,
  marketingCopy,
  showcaseCases,
  wallColumns,
  wallSrc,
} from '../marketing'
import { type MarketingMotion, startMarketingMotion } from '../marketingMotion'
import { ContactModal } from './ContactModal'

export function MarketingHome({ locale, start }: { locale: Locale; start: () => void }) {
  const text = marketingCopy[locale]
  const rootRef = useRef<HTMLElement>(null)
  const motionRef = useRef<MarketingMotion | null>(null)
  const contactOpenRef = useRef(false)
  const [contactOpen, setContactOpen] = useState(false)
  const cases = showcaseCases(locale)
  const home = locale === 'en' ? '/en/' : '/'
  const columns = wallColumns()
  const rows = libraryRows()
  contactOpenRef.current = contactOpen

  useEffect(() => {
    const nav = rootRef.current?.querySelector('.nav')
    if (!nav) return
    const mark = () => nav.classList.toggle('solid', window.scrollY > window.innerHeight * 0.5)
    mark()
    window.addEventListener('scroll', mark, { passive: true })
    return () => window.removeEventListener('scroll', mark)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const narrow = window.matchMedia('(max-width: 760px)')
    let cancelled = false
    let generation = 0
    const boot = () => {
      const ticket = ++generation
      motionRef.current?.destroy()
      motionRef.current = null
      root.classList.toggle('mkt-static', reduced.matches)
      if (reduced.matches) return
      void startMarketingMotion(root, narrow.matches).then((motion) => {
        if (cancelled || ticket !== generation || reduced.matches) {
          motion.destroy()
          return
        }
        motionRef.current = motion
        if (contactOpenRef.current) motion.stop()
      })
    }
    boot()
    reduced.addEventListener('change', boot)
    narrow.addEventListener('change', boot)
    return () => {
      cancelled = true
      generation += 1
      reduced.removeEventListener('change', boot)
      narrow.removeEventListener('change', boot)
      motionRef.current?.destroy()
      motionRef.current = null
    }
  }, [])

  useEffect(() => {
    if (contactOpen) motionRef.current?.stop()
    else motionRef.current?.start()
  }, [contactOpen])

  const openContact = (event: { preventDefault(): void }) => {
    event.preventDefault()
    setContactOpen(true)
  }

  return (
    <main className="mkt" ref={rootRef} data-locale={locale}>
      <nav className="nav" id="nav">
        <a className="brand" href={home}>
          <img src={MARK} width={30} height={30} alt="" />
          {text.brand}
        </a>
        <div className="links">
          <a href="#demo">{text.nav.cases}</a>
          <a href="#feat">{text.nav.features}</a>
          <a href="#gal">{text.nav.inspiration}</a>
          <a href={editions[locale].root}>{text.nav.guide}</a>
        </div>
        <div className="nav-end">
          <a
            className="lang"
            href={locale === 'en' ? '/' : '/en/'}
            hrefLang={locale === 'en' ? 'zh-CN' : 'en'}
          >
            {locale === 'en' ? '中文' : 'EN'}
          </a>
          <button type="button" className="cta" onClick={start}>
            {text.nav.start}
          </button>
        </div>
      </nav>

      <header className="hero" id="hero">
        <div className="wall" id="wall">
          {columns.map((column, columnIndex) => (
            <div className="col" key={columnIndex}>
              {column.map((file, imageIndex) => (
                <figure key={`${file}-${imageIndex}`}>
                  <img
                    src={wallSrc(file)}
                    alt=""
                    decoding="async"
                    fetchPriority={columnIndex === 4 && imageIndex < 2 ? 'high' : 'low'}
                  />
                </figure>
              ))}
            </div>
          ))}
        </div>
        <div className="vign" id="vign" />
        <div className="zoomer" id="zoomer">
          <img src={`${ASSET}/reveal-whale.webp`} alt="" />
        </div>
        <div className="htitle" id="htitle">
          <h1 className="disp">
            {text.hero.line1}
            <br />
            <span className="o">{text.hero.line2}</span>
          </h1>
          <p>
            <HeroBody body={text.hero.body} />
          </p>
          <div className="row">
            <button type="button" className="cta" onClick={start}>
              {text.hero.start}
            </button>
            <a className="ghost" href="#demo">
              {text.hero.see}
            </a>
          </div>
          <div className="hero-note">{text.hero.note}</div>
        </div>
        <div className="scrollhint" id="hint">
          {text.hero.scroll}
        </div>
      </header>

      <section className="demo" id="demo">
        <div className="dimg" id="dimg">
          {cases.map((item, index) => (
            <figure
              key={item.key}
              className={
                item.fit === 'cover'
                  ? `cover${index === 0 ? ' on' : ''}`
                  : index === 0
                    ? 'on'
                    : undefined
              }
              data-id={item.id ?? ''}
              data-key={item.key}
              data-model={item.model}
              data-category={item.category}
              data-prompt={item.prompt}
            >
              <img className="bg" src={item.image} alt="" />
              <img className="fg" src={item.image} alt={`${item.key}`} />
              <span className="cap">
                {item.key} · {text.demo.caption}
              </span>
            </figure>
          ))}
        </div>
        <div className="dcopy" id="dcopy">
          <div className="eyebrow">
            {text.demo.eyebrow} · <span id="dnum">01</span> / 04
          </div>
          <h2 className="disp">
            {text.demo.line1}
            <br />
            <span className="o">{text.demo.line2}</span>
          </h2>
          <p className="dlead">{text.demo.lead}</p>
          <div className="pcard">
            <div className="lab">{text.demo.prompt}</div>
            <div className="ptext" id="dprompt">
              {cases[0]?.prompt}
            </div>
            <div className="pmeta">
              <span className="chip" id="dmodel">
                {cases[0]?.model}
              </span>
              <span className="chip" id="dcat">
                {cases[0]?.category}
              </span>
              <a className="cta" id="dsame" href={caseHref(cases[0]?.id ?? null)}>
                {text.demo.same}
              </a>
            </div>
          </div>
          <ol className="dtabs" id="dtabs">
            {cases.map((item, index) => (
              <li key={item.key} className={index === 0 ? 'on' : undefined}>
                {item.key}
              </li>
            ))}
          </ol>
        </div>
        <div className="dmob" id="dmob">
          <div className="hd">
            <div className="eyebrow">{text.demo.eyebrow}</div>
            <h2 className="disp">
              {text.demo.line1}
              <br />
              <span className="o">{text.demo.line2}</span>
            </h2>
            <p className="dlead">{text.demo.lead}</p>
          </div>
          {cases.map((item) => (
            <article key={item.key}>
              <figure>
                <img src={item.image} alt={`${item.key}`} loading="lazy" decoding="async" />
              </figure>
              <div className="pcard">
                <div className="lab">{text.demo.prompt}</div>
                <div className="ptext">{item.prompt}</div>
                <div className="pmeta">
                  <span className="chip">{item.model}</span>
                  <span className="chip">{item.category}</span>
                  <a className="cta" href={caseHref(item.id)}>
                    {text.demo.same}
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="feat" id="feat">
        <div className="fhead">
          <h2 className="disp">{text.featuresTitle}</h2>
          <p>{text.featuresNote}</p>
        </div>
        <div className="fpin" id="fpin">
          <ol className="flist" id="flist">
            {text.features.map((feature, index) => (
              <li key={feature.title} className={index === 0 ? 'on' : undefined}>
                <i />
                <b>
                  <em>0{index + 1}</em>
                  {feature.title}
                </b>
                <p>{feature.body}</p>
              </li>
            ))}
          </ol>
          <div className="fstage" id="fstage">
            {text.features.map((feature, index) => (
              <div className={`bf${index === 0 ? ' on' : ''}`} key={feature.image}>
                <Frame url={feature.url} />
                <img
                  src={`${ASSET}/ui/${feature.image}.webp`}
                  width={1440}
                  height={900}
                  alt={`${feature.title}`}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            ))}
          </div>
        </div>
        <div className="fmob" id="fmob">
          {text.features.map((feature, index) => (
            <article key={feature.title}>
              <em>0{index + 1}</em>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <div className="bf">
                <Frame url={feature.url} />
                <img
                  src={`${ASSET}/ui/${feature.image}.webp`}
                  width={1440}
                  height={900}
                  alt={`${feature.title}`}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="gal" id="gal">
        <div className="head">
          <div>
            <h2 className="disp">
              {text.gallery.line1}
              <br />
              <span className="o">{text.gallery.line2}</span>
            </h2>
          </div>
          <div>
            <p>
              {text.gallery.lead} <a href="/explore">{text.gallery.explore}</a>
            </p>
            <ul className="gpts">
              {text.gallery.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="gstage" id="gstage">
          <div className="bf main" id="gmain">
            <Frame url="muvloom.online/explore" />
            <img
              src={`${ASSET}/ui/explore-v2.webp`}
              width={1440}
              height={900}
              alt={text.gallery.feedAlt}
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="bf det" id="gdet">
            <Frame url={text.gallery.detailUrl} />
            <img
              src={`${ASSET}/ui/explore-detail.webp`}
              width={1280}
              height={836}
              alt={text.gallery.detailAlt}
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
        <div className="gmob">
          <figure>
            <img
              src={`${ASSET}/ui/explore-mobile-feed.webp`}
              width={390}
              height={844}
              alt={text.gallery.feedMobileAlt}
              loading="lazy"
              decoding="async"
            />
          </figure>
          <figure>
            <img
              src={`${ASSET}/ui/explore-mobile-detail.webp`}
              width={390}
              height={844}
              alt={text.gallery.detailMobileAlt}
              loading="lazy"
              decoding="async"
            />
          </figure>
        </div>
      </section>

      <section className="end" id="end">
        <div className="marq" id="marq">
          {rows.map((row, index) => (
            <div className="mrow" key={index}>
              {row.map((file, imageIndex) => (
                <figure key={`${file}-${imageIndex}`}>
                  <img src={wallSrc(file)} alt="" loading="lazy" decoding="async" />
                </figure>
              ))}
            </div>
          ))}
        </div>
        <div className="in">
          <img className="mk" src={MARK} width={44} height={44} alt="" />
          <h2 className="disp">{text.end.title}</h2>
          <p>{text.end.body}</p>
          <div className="row">
            <button type="button" className="cta" onClick={start}>
              {text.end.start}
            </button>
            <a className="ghost" href="/explore">
              {text.end.browse}
            </a>
          </div>
          <div className="note">{text.end.note}</div>
        </div>
      </section>

      <footer className="foot">
        <div className="top">
          <div>
            <a className="bd" href={home}>
              <img src={MARK} width={26} height={26} alt="" />
              {text.brand}
            </a>
            <p className="tag">{text.footer.tagline}</p>
          </div>
          <div className="cols">
            <div>
              <b>{text.footer.product}</b>
              <a href="#demo">{text.nav.cases}</a>
              <a href="#feat">{text.nav.features}</a>
              <a href="#gal">{text.nav.inspiration}</a>
            </div>
            <div>
              <b>{text.footer.help}</b>
              <a href={editions[locale].root}>{text.nav.guide}</a>
              <a href="#contact" onClick={openContact}>
                {text.footer.contact}
              </a>
            </div>
            <div>
              <b>{text.footer.legal}</b>
              <a href="/terms">{text.footer.terms}</a>
              <a href="/privacy">{text.footer.privacy}</a>
            </div>
          </div>
        </div>
        <div className="bot">
          <span>{text.footer.copy}</span>
          <span>{text.footer.domain}</span>
        </div>
      </footer>
      <ContactModal open={contactOpen} locale={locale} onClose={() => setContactOpen(false)} />
    </main>
  )
}

function HeroBody({ body }: { body: string }) {
  const chinese = body.indexOf('。')
  const english = body.indexOf('. ')
  const end = chinese >= 0 ? chinese + 1 : english >= 0 ? english + 1 : -1
  if (end < 0) return body
  return (
    <>
      {body.slice(0, end)}
      <br className="dk" />
      {body.slice(end)}
    </>
  )
}

function Frame({ url }: { url: string }) {
  return (
    <div className="bar">
      <s />
      <s />
      <s />
      <u>{url}</u>
    </div>
  )
}
