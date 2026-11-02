import type { ShowcaseCase } from './marketing'

export interface MarketingMotion {
  stop(): void
  start(): void
  destroy(): void
}

/** 原型里的滚动编排：平滑滚动、首屏墙、鲸鱼交接、案例与功能钉住。 */
export async function startMarketingMotion(
  root: HTMLElement,
  mobile: boolean,
): Promise<MarketingMotion> {
  const [{ default: gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
    import('gsap'),
    import('gsap/ScrollTrigger'),
    import('lenis'),
  ])
  gsap.registerPlugin(ScrollTrigger)
  const lenis = new Lenis({ lerp: 0.09, anchors: true })
  const onLenisScroll = () => ScrollTrigger.update()
  const offLenis = lenis.on('scroll', onLenisScroll)
  const onTick = (time: number) => lenis.raf(time * 1000)
  gsap.ticker.add(onTick)
  gsap.ticker.lagSmoothing(0)

  const nav = root.querySelector<HTMLElement>('.nav')
  const markNav = () => nav?.classList.toggle('solid', window.scrollY > window.innerHeight * 0.5)
  const onScroll = () => markNav()
  lenis.on('scroll', onScroll)
  window.addEventListener('scroll', onScroll, { passive: true })
  markNav()

  const cols = [...root.querySelectorAll<HTMLElement>('#wall .col')].map((el, index) => ({
    el,
    y: 0,
    sp: (index % 2 ? 1 : -1) * (0.35 + ((index * 37) % 10) / 22),
  }))
  let boost = 0
  const drift = () => {
    for (const column of cols) {
      const height = column.el.scrollHeight / 2
      if (!height) continue
      column.y += column.sp * (1 + boost)
      if (column.y < -height) column.y += height
      if (column.y > 0) column.y -= height
      column.el.style.transform = `translateY(${column.y}px)`
    }
    boost *= 0.93
  }
  gsap.ticker.add(drift)
  let featureOut = 0
  const ctx = gsap.context(() => {
    const wall = root.querySelector<HTMLElement>('#wall')
    ScrollTrigger.create({
      onUpdate: (self) => {
        boost = Math.min(Math.abs(self.getVelocity()) / 180, 12)
      },
    })
    if (wall) gsap.from(wall, { scale: 1.6, opacity: 0, duration: 2, ease: 'power3.out' })
    gsap.from('.htitle h1', {
      yPercent: 30,
      opacity: 0,
      duration: 1.2,
      delay: 0.3,
      ease: 'power4.out',
    })
    gsap.from('.htitle p, .htitle .row, .hero-note', {
      y: 24,
      opacity: 0,
      stagger: 0.12,
      duration: 1,
      delay: 0.7,
    })
    gsap.set('#zoomer', { x: 0, y: 0, xPercent: -50, yPercent: -50 })
    const hero = gsap.timeline({
      scrollTrigger: { trigger: '#hero', start: 'top top', end: '+=220%', pin: true, scrub: 1 },
    })
    hero
      .to('#htitle', { scale: 1.4, opacity: 0, ease: 'power1.in', duration: 0.35 }, 0)
      .to('#hint', { opacity: 0, duration: 0.1 }, 0)
      .to(
        '#wall',
        { rotateX: 0, rotateZ: 0, scale: mobile ? 1.1 : 1.25, ease: 'power2.inOut', duration: 0.6 },
        0,
      )
      .to('#vign', { opacity: 0.35, duration: 0.4 }, 0)
      .fromTo('#zoomer', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.15 }, 0.45)
      .to(
        '#zoomer',
        {
          width: '100vw',
          height: '100vh',
          aspectRatio: 'auto',
          borderRadius: 0,
          ease: 'power2.in',
          duration: 0.4,
        },
        0.6,
      )
      .to('#wall', { scale: 2.6, opacity: 0, ease: 'power2.in', duration: 0.4 }, 0.6)
    if (!mobile) hero.to({}, { duration: 0.84 }, 1)

    const cases = readCases(root)
    if (!mobile && cases.length > 0) {
      const figures = [...root.querySelectorAll<HTMLElement>('#dimg figure')]
      const tabs = [...root.querySelectorAll<HTMLElement>('#dtabs li')]
      const number = root.querySelector<HTMLElement>('#dnum')
      const prompt = root.querySelector<HTMLElement>('#dprompt')
      const model = root.querySelector<HTMLElement>('#dmodel')
      const category = root.querySelector<HTMLElement>('#dcat')
      let current = -1
      const setCase = (index: number) => {
        if (index === current) return
        current = index
        figures.forEach((figure, key) => figure.classList.toggle('on', key === index))
        tabs.forEach((tab, key) => tab.classList.toggle('on', key === index))
        if (number) number.textContent = `0${index + 1}`
        const item = cases[index]
        const same = root.querySelector<HTMLAnchorElement>('#dsame')
        if (same)
          same.href = item?.id ? `/explore#inspirations/${encodeURIComponent(item.id)}` : '/explore'
        if (!prompt || !model || !category || !item) return
        prompt.style.opacity = '0'
        window.setTimeout(() => {
          prompt.textContent = item.prompt
          model.textContent = item.model
          category.textContent = item.category
          prompt.style.opacity = '1'
        }, 180)
      }
      setCase(0)
      gsap.fromTo(
        '#dimg figure',
        { yPercent: -100 },
        {
          yPercent: 0,
          ease: 'none',
          immediateRender: true,
          scrollTrigger: {
            trigger: '#demo',
            start: 'top bottom',
            end: 'top top',
            scrub: true,
            invalidateOnRefresh: true,
          },
        },
      )
      const box = () => ({
        left: window.innerWidth * 0.45,
        top: window.innerHeight * 0.11,
        width: window.innerWidth * 0.5,
        height: window.innerHeight * 0.78,
      })
      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: '#demo',
          start: 'top top',
          end: '+=420%',
          pin: true,
          scrub: 0.6,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const progress = (self.progress - 0.2) / 0.8
            setCase(
              progress < 0 ? 0 : Math.min(cases.length - 1, Math.floor(progress * cases.length)),
            )
          },
        },
      })
      timeline
        .to(
          '#dimg',
          {
            left: () => box().left,
            top: () => box().top,
            width: () => box().width,
            height: () => box().height,
            borderRadius: 18,
            ease: 'power2.inOut',
            duration: 0.2,
          },
          0,
        )
        .fromTo('#dcopy', { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.12 }, 0.06)
        .to('#dimg .cap', { opacity: 1, duration: 0.05 }, 0.17)
        .to({}, { duration: 0.8 }, 0.2)
    } else {
      root.querySelectorAll('#dmob article').forEach((article) => {
        gsap.from(article, {
          y: 50,
          opacity: 0,
          duration: 0.8,
          ease: 'power3.out',
          scrollTrigger: { trigger: article, start: 'top 88%' },
        })
      })
    }

    gsap.from('.fhead > *', {
      y: 30,
      opacity: 0,
      stagger: 0.1,
      duration: 0.9,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.fhead', start: 'top 75%' },
    })
    if (!mobile) {
      const items = [...root.querySelectorAll<HTMLElement>('#flist li')]
      const frames = [...root.querySelectorAll<HTMLElement>('#fstage .bf')]
      const count = items.length
      let current = -1
      const setFeature = (index: number) => {
        if (index === current) return
        const previous = current
        current = index
        items.forEach((item, key) => item.classList.toggle('on', key === index))
        frames.forEach((frame, key) => {
          frame.classList.remove('out')
          frame.classList.toggle('on', key === index)
        })
        const previousFrame = frames[previous]
        if (previous >= 0 && previousFrame) {
          previousFrame.classList.add('out')
          window.clearTimeout(featureOut)
          featureOut = window.setTimeout(() => previousFrame.classList.remove('out'), 800)
        }
      }
      if (count > 0) setFeature(0)
      root.querySelectorAll('#fstage img').forEach((image) => {
        image.setAttribute('loading', 'eager')
      })
      const pin = ScrollTrigger.create({
        trigger: '#fpin',
        start: 'top top',
        end: `+=${count * 70}%`,
        pin: true,
        onUpdate: (self) => {
          const position = self.progress * count
          const index = Math.min(count - 1, Math.floor(position))
          setFeature(index)
          items.forEach((item, key) => {
            const bar = item.firstElementChild
            if (!(bar instanceof HTMLElement)) return
            const amount = key < index ? 0 : key === index ? Math.min(1, position - index) * 100 : 0
            bar.style.height = `${amount}%`
          })
        },
      })
      items.forEach((item, index) => {
        item.onclick = () => {
          lenis.scrollTo(pin.start + ((pin.end - pin.start) * (index + 0.15)) / count)
        }
      })
      gsap.from('#fpin', {
        opacity: 0,
        y: 40,
        duration: 1,
        ease: 'power3.out',
        scrollTrigger: { trigger: '#fpin', start: 'top 80%' },
      })
    } else {
      root.querySelectorAll('#fmob article').forEach((article) => {
        gsap.from(article, {
          y: 50,
          opacity: 0,
          duration: 0.8,
          ease: 'power3.out',
          scrollTrigger: { trigger: article, start: 'top 88%' },
        })
      })
    }

    if (!mobile) {
      gsap.from('#gmain', {
        y: 80,
        opacity: 0,
        duration: 1,
        ease: 'power3.out',
        scrollTrigger: { trigger: '#gstage', start: 'top 85%' },
      })
      gsap.fromTo(
        '#gdet',
        { y: 220, x: 80 },
        {
          y: 0,
          x: 0,
          ease: 'none',
          scrollTrigger: { trigger: '#gstage', start: 'top 75%', end: 'top 15%', scrub: true },
        },
      )
    }
    gsap.from('.gal .head > *', {
      y: 30,
      opacity: 0,
      stagger: 0.1,
      duration: 1,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.gal', start: 'top 70%' },
    })
    root.querySelectorAll<HTMLElement>('#marq .mrow').forEach((row, index) => {
      gsap.fromTo(
        row,
        { xPercent: index ? -50 : 0 },
        { xPercent: index ? 0 : -50, duration: 90, ease: 'none', repeat: -1 },
      )
    })
    gsap.from('#end .in > *', {
      y: 30,
      opacity: 0,
      stagger: 0.08,
      duration: 0.9,
      ease: 'power3.out',
      scrollTrigger: { trigger: '#end', start: 'top 70%' },
    })
  }, root)

  const refresh = () => ScrollTrigger.refresh()
  window.addEventListener('load', refresh)

  return {
    stop: () => lenis.stop(),
    start: () => lenis.start(),
    destroy: () => {
      window.removeEventListener('load', refresh)
      window.removeEventListener('scroll', onScroll)
      offLenis()
      window.clearTimeout(featureOut)
      ctx.revert()
      gsap.ticker.remove(drift)
      gsap.ticker.remove(onTick)
      gsap.ticker.lagSmoothing(500, 33)
      lenis.destroy()
    },
  }
}

function readCases(root: HTMLElement): ShowcaseCase[] {
  return [...root.querySelectorAll<HTMLElement>('#dimg figure')].map((figure) => ({
    id: figure.dataset.id || null,
    key: figure.dataset.key ?? '',
    image: '',
    model: figure.dataset.model ?? '',
    category: figure.dataset.category ?? '',
    prompt: figure.dataset.prompt ?? '',
  }))
}
