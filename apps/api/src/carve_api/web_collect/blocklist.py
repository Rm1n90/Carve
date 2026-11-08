# Armin Mehri — mehri.armin@gmail.com
"""Sites whose images are never collected.

Matched against both the image's own address and the page it was found
on, by domain suffix: stock agencies serve their previews from CDNs with
other names (Adobe Stock from ftcdn.net), and an image hot-linked from a
stock CDN onto a blog is still the agency's watermarked preview.

Three groups, all on by default:

* stock and watermark agencies — their previews carry a watermark;
* AI-image galleries — generated images;
* Chinese sites — many are watermarked reposts; left out only when a
  run asks (Baidu and 360 Search find mostly these, and the run's
  filters judge each image).

Admins add more in Settings → Configuration (``WEB_COLLECT_BLOCKED_SITES``).
"""

from __future__ import annotations

from urllib.parse import urlsplit

STOCK = (
    "123rf.com",
    "adobe.com",
    "adobestock.com",
    "ftcdn.net",
    "agefotostock.com",
    "alamy.com",
    "alamyimages.fr",
    "alamy.de",
    "alamy.es",
    "alamy.it",
    "bigstockphoto.com",
    "canstockphoto.com",
    "colourbox.com",
    "depositphotos.com",
    "dreamstime.com",
    "envato.com",
    "envatousercontent.com",
    "featurepics.com",
    "fotosearch.com",
    "freepik.com",
    "gettyimages.com",
    "gettyimages.co.uk",
    "gettyimages.de",
    "gettyimages.es",
    "gettyimages.it",
    "gettyimages.fr",
    "gettyimages.ca",
    "gettyimages.com.au",
    "imago-images.com",
    "imago-images.de",
    "istockphoto.com",
    "masterfile.com",
    "mediastorehouse.com",
    "megapixl.com",
    "panthermedia.net",
    "photodune.net",
    "pond5.com",
    "pngtree.com",
    "rfclipart.com",
    "shutterstock.com",
    "stocksy.com",
    "storyblocks.com",
    "superstock.com",
    "vecteezy.com",
    "vectorstock.com",
    "wirestock.io",
    "eyeem.com",
    "picfair.com",
    "photocase.com",
    "stockfresh.com",
    "fotolia.com",
    "crushpixel.com",
    "pixtastock.com",
    "lookphotos.com",
    "focusedcollection.com",
    "glowimages.com",
    "zoonar.com",
    "zoonar.de",
    "photos.com",
    "thinkstockphotos.com",
    "dissolve.com",
    "offset.com",
    "westend61.de",
    "plainpicture.com",
    "mauritius-images.com",
    "age-fotostock.com",
    "stockphotosecrets.com",
    "sciencephoto.com",
    "granger.com",
    "bridgemanimages.com",
    "mary-evans.co.uk",
    "topfoto.co.uk",
    "akg-images.com",
    "lightrocket.com",
    "zumapress.com",
    "newscom.com",
    "sipausa.com",
    "abacapress.com",
    "dpa-picture-alliance.de",
    "picture-alliance.com",
    "shutterfly.com",
    # Re-posts and pin boards: mostly small, cropped or watermarked copies.
    "pinimg.com",
    "pinterest.com",
    "pinterest.co.uk",
    "pinterest.es",
    "pinterest.it",
    "pinterest.de",
    "pinterest.fr",
    "pinterest.ca",
    "pinterest.com.au",
    "pinterest.com.mx",
)

AI_GALLERIES = (
    "stablediffusionweb.com",
    "lexica.art",
    "civitai.com",
    "openart.ai",
    "nightcafe.studio",
    "creator.nightcafe.studio",
    "playgroundai.com",
    "playground.com",
    "pixai.art",
    "midjourney.com",
    "tensor.art",
    "seaart.ai",
    "leonardo.ai",
    "krea.ai",
    "getimg.ai",
    "dreamstudio.ai",
    "craiyon.com",
    "starryai.com",
    "artbreeder.com",
    "deepai.org",
    "aiartshop.com",
    "prompthero.com",
    "promptbase.com",
    "imagine.art",
    "ideogram.ai",
    "mage.space",
    "dezgo.com",
    "perchance.org",
    "yodayo.com",
    "neural.love",
    "arthub.ai",
    "freepik.ai",
    "aiease.ai",
)

CHINESE = (
    "baidu.com",
    "bdimg.com",
    "bdstatic.com",
    "qq.com",
    "gtimg.com",
    "qpic.cn",
    "sohu.com",
    "163.com",
    "126.net",
    "126.com",
    "sina.com",
    "sinaimg.cn",
    "weibo.com",
    "weibo.cn",
    "zhihu.com",
    "zhimg.com",
    "alicdn.com",
    "alibaba.com",
    "aliexpress.com",
    "taobao.com",
    "tmall.com",
    "jd.com",
    "360buyimg.com",
    "douyin.com",
    "douyinpic.com",
    "bilibili.com",
    "hdslb.com",
    "xiaohongshu.com",
    "xhscdn.com",
    "toutiao.com",
    "toutiaoimg.com",
    "pstatp.com",
    "byteimg.com",
    "bytedance.com",
    "csdn.net",
    "ifeng.com",
    "ifengimg.com",
    "huaban.com",
    "nipic.com",
    "699pic.com",
    "quanjing.com",
    "veer.com",
    "sucaifengbao.com",
    "51yuansu.com",
    "ooopic.com",
    "16pic.com",
    "58pic.com",
    "ibaotu.com",
    "zcool.com.cn",
    "duitang.com",
    "dianping.com",
    "meituan.net",
    "autohome.com.cn",
    "pcauto.com.cn",
    "yiche.com",
    "dongchedi.com",
    "bitauto.com",
    "so.com",
    "qhimg.com",
    "qhres.com",
    "sogou.com",
    "sogoucdn.com",
    "360.cn",
    "youku.com",
    "iqiyi.com",
    "kuaishou.com",
    "douban.com",
    "doubanio.com",
    "jianshu.com",
    "jianshu.io",
    "52pk.com",
    "pconline.com.cn",
    "sznews.com",
    "people.com.cn",
    "xinhuanet.com",
    "chinadaily.com.cn",
    "cctv.com",
    "cntv.cn",
    "thepaper.cn",
    "36kr.com",
    "huxiu.com",
    "mafengwo.net",
    "ctrip.com",
    "tripcdn.com",
    "vcg.com",
    "fotomore.com",
    "tuchong.com",
    "lofter.com",
    "lf127.net",
    "tukuppt.com",
    "pngtree.cn",
    "zol.com.cn",
    "zol-img.com.cn",
    "hupu.com",
    "hoopchina.com.cn",
)
# Any address under these top-level domains.
CHINESE_TLDS = (".cn", ".com.cn", ".net.cn", ".org.cn", ".gov.cn")

DEFAULT_GROUPS: dict[str, tuple[str, ...]] = {
    "stock": STOCK,
    "ai": AI_GALLERIES,
    "chinese": CHINESE,
}


def host_of(url: str | None) -> str:
    if not url:
        return ""
    try:
        return (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def parse_extra(text: str | None) -> tuple[str, ...]:
    """The admin's own list: one domain per line (or comma separated),
    an address or a leading ``*.`` / ``.`` allowed."""
    out: list[str] = []
    for raw in (text or "").replace(",", "\n").splitlines():
        item = raw.strip().lower()
        if not item or item.startswith("#"):
            continue
        if "//" in item:
            item = host_of(item)
        item = item.lstrip("*").lstrip(".").split("/")[0]
        # "www.site.com" means the whole site.
        item = item.removeprefix("www.")
        if item:
            out.append(item)
    return tuple(out)


class Blocklist:
    """Suffix match of a host against the blocked domains."""

    def __init__(self, extra: tuple[str, ...] = (), chinese: bool = True) -> None:
        self.chinese = chinese
        self._by_domain: dict[str, str] = {}
        for group, domains in DEFAULT_GROUPS.items():
            if group == "chinese" and not chinese:
                continue
            for d in domains:
                self._by_domain.setdefault(d, group)
        for d in extra:
            self._by_domain.setdefault(d, "custom")

    def reason(self, *urls: str | None) -> str | None:
        """The group that blocks any of ``urls`` ("stock", "ai",
        "chinese", "custom"), or ``None``."""
        for url in urls:
            host = host_of(url)
            if not host:
                continue
            if self.chinese and host.endswith(CHINESE_TLDS):
                return "chinese"
            parts = host.split(".")
            for i in range(len(parts) - 1):
                group = self._by_domain.get(".".join(parts[i:]))
                if group:
                    return group
        return None
