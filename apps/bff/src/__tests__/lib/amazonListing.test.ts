import { describe, expect, it } from 'bun:test'
import {
  isAllowedListingImageUrl,
  parseAmazonListingUrl,
  parseListingPage,
} from '../../lib/amazonListing'

const hiResSample = `<!doctype html><html><head><title>Amazon.com: Tub</title></head><body>
<span id="productTitle">   Abruzzo Freestanding   Bathtub 67 inch  </span>
<script type="text/javascript">
P.when('A').register("ImageBlockATF", function(A){
var data = {'colorImages': { 'initial': [
{"hiRes":"https://m.media-amazon.com/images/I/71aaaaaaaaL._AC_SL1500_.jpg","thumb":"https://m.media-amazon.com/images/I/31aaaaaaaaL._AC_US40_.jpg","variant":"MAIN"},
{"hiRes":"https://m.media-amazon.com/images/I/71bbbbbbbbL._AC_SL1500_.jpg","variant":"PT01"},
{"hiRes":null,"thumb":"https://m.media-amazon.com/images/I/31cccccccc._AC_US40_.jpg","variant":"PT02"},
{"hiRes":"https:\\/\\/m.media-amazon.com\\/images\\/I\\/71ffffffffL._AC_SL1500_.jpg","variant":"PT03"},
{"hiRes":"https://m.media-amazon.com/images/I/71aaaaaaaaL._AC_SL1500_.jpg","variant":"PT04"}
]}};
});
</script>
<div id="altImages"><ul><li><img src="https://m.media-amazon.com/images/I/31zzzzzzzz._AC_US40_.jpg"></li></ul></div>
</body></html>`

const altImagesSample = `<!doctype html><html><body>
<span id="productTitle">Ceramic Basin</span>
<div id="imageBlock"><img src="https://m.media-amazon.com/images/I/99decoy._AC_SX679_.jpg"></div>
<div id="altImages"><ul class="a-unordered-list">
<li><span><img alt="" src="https://m.media-amazon.com/images/I/31dddddddd._AC_US40_.jpg"></span></li>
<li><img src="https://m.media-amazon.com/images/I/31eeeeeeee._AC_US100_.jpg" alt="side"></li>
<li><img src="https://m.media-amazon.com/images/I/31dddddddd._AC_US100_.jpg"></li>
<li><img src="https://images-na.ssl-images-amazon.com/images/G/01/common/transparent-pixel._V1_.gif"></li>
</ul></div>
</body></html>`

const captchaSample = `<!doctype html><html><head><title>Amazon.com</title></head><body>
<img src="https://images-na.ssl-images-amazon.com/images/G/01/nav/amazon-logo._CB1_.png">
<h4>Enter the characters you see below</h4>
<form action="/errors/validateCaptcha"><input name="field-keywords"></form>
</body></html>`

describe('parseAmazonListingUrl', () => {
  it('accepts amazon product pages and normalizes them to a canonical URL', () => {
    expect(parseAmazonListingUrl('https://www.amazon.com/dp/B0FVLNS696')).toEqual({
      asin: 'B0FVLNS696',
      canonicalUrl: 'https://www.amazon.com/dp/B0FVLNS696',
    })
    expect(
      parseAmazonListingUrl(
        'https://www.amazon.co.uk/Abruzzo-Bathtub/dp/b0fvlns696/ref=sr_1_3?th=1',
      ),
    ).toEqual({
      asin: 'B0FVLNS696',
      canonicalUrl: 'https://www.amazon.co.uk/dp/B0FVLNS696',
    })
    expect(parseAmazonListingUrl('https://amazon.de/gp/product/B0H8YGPK5Z/')).toEqual({
      asin: 'B0H8YGPK5Z',
      canonicalUrl: 'https://amazon.de/dp/B0H8YGPK5Z',
    })
  })

  it('rejects other hosts, non-product paths and non-http protocols', () => {
    expect(parseAmazonListingUrl('https://amazon.com.evil.example/dp/B0FVLNS696')).toBeNull()
    expect(parseAmazonListingUrl('https://notamazon.com/dp/B0FVLNS696')).toBeNull()
    expect(parseAmazonListingUrl('https://www.amazon.com/s?k=bathtub')).toBeNull()
    expect(parseAmazonListingUrl('https://www.amazon.com/dp/TOOSHORT')).toBeNull()
    expect(parseAmazonListingUrl('javascript:alert(1)//amazon.com/dp/B0FVLNS696')).toBeNull()
    expect(parseAmazonListingUrl('not a url')).toBeNull()
  })
})

describe('parseListingPage', () => {
  it('prefers hiRes URLs from the image block script', () => {
    expect(parseListingPage(hiResSample)).toEqual({
      title: 'Abruzzo Freestanding Bathtub 67 inch',
      images: [
        'https://m.media-amazon.com/images/I/71aaaaaaaaL._AC_SL1500_.jpg',
        'https://m.media-amazon.com/images/I/71bbbbbbbbL._AC_SL1500_.jpg',
        'https://m.media-amazon.com/images/I/71ffffffffL._AC_SL1500_.jpg',
      ],
    })
  })

  it('falls back to altImages thumbnails with the size suffix stripped', () => {
    expect(parseListingPage(altImagesSample)).toEqual({
      title: 'Ceramic Basin',
      images: [
        'https://m.media-amazon.com/images/I/31dddddddd.jpg',
        'https://m.media-amazon.com/images/I/31eeeeeeee.jpg',
      ],
    })
  })

  it('returns no images for an anti-bot challenge page', () => {
    expect(parseListingPage(captchaSample).images).toEqual([])
  })

  it('caps the gallery at 30 images', () => {
    const many = Array.from(
      { length: 40 },
      (_, index) =>
        `{"hiRes":"https://m.media-amazon.com/images/I/7${index}xxxxxxxx._AC_SL1500_.jpg"}`,
    ).join(',')
    expect(parseListingPage(`<script>[${many}]</script>`).images).toHaveLength(30)
  })
})

describe('isAllowedListingImageUrl', () => {
  it('allows only https amazon image hosts', () => {
    expect(isAllowedListingImageUrl('https://m.media-amazon.com/images/I/71a.jpg')).toBe(true)
    expect(isAllowedListingImageUrl('https://images-na.ssl-images-amazon.com/images/I/71a.jpg')).toBe(
      true,
    )
    expect(isAllowedListingImageUrl('https://images-eu.ssl-images-amazon.com/images/I/71a.jpg')).toBe(
      true,
    )
    expect(isAllowedListingImageUrl('http://m.media-amazon.com/images/I/71a.jpg')).toBe(false)
    expect(isAllowedListingImageUrl('https://m.media-amazon.com.evil.example/images/I/71a.jpg')).toBe(
      false,
    )
    expect(isAllowedListingImageUrl('https://www.amazon.com/images/I/71a.jpg')).toBe(false)
    expect(isAllowedListingImageUrl('nonsense')).toBe(false)
  })
})
