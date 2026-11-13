"""Draw the companion from one shared SVG base, then change only named parts.

Run with Python 3. No image service, image download, or third-party dependency.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent

HEADER = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" fill="none" role="img" aria-labelledby="title desc">
  <title id="title">{title}</title>
  <desc id="desc">手绘小黑同人练琴伙伴，炭黑色小猫抱着木质卡林巴。{description}</desc>
'''

# Every pose keeps the same body, head outline, ground line, and instrument.
BODY = '''  <ellipse data-part="ground" cx="161" cy="302" rx="88" ry="9" fill="#283C2E" opacity=".09"/>
  <path data-part="tail" d="M216 272c27 10 57-4 56-30-1-18-19-25-27-14-7 10 1 20 10 17" stroke="#23352E" stroke-width="19" stroke-linecap="round"/>
  <path data-part="body" d="M116 195c-14 17-21 49-17 74 2 17 14 29 30 30h61c21-1 35-17 34-36-1-25-8-52-23-68H116Z" fill="#2C3F35"/>
  <path d="M116 215c-8 20-10 38-7 56 2 9 6 15 13 18" stroke="#3C5142" stroke-width="5" stroke-linecap="round"/>
  <path data-part="feet" d="M111 281c-12 0-21 7-20 15 1 6 10 8 23 8h26v-17c-8-4-18-6-29-6Zm97 0c12 0 21 7 20 15-1 6-10 8-23 8h-26v-17c8-4 18-6 29-6Z" fill="#23352E"/>
  <path d="M104 296h10m88 0h10" stroke="#576B52" stroke-width="2.4" stroke-linecap="round"/>
  <path data-part="head" d="M77 108 76 43c0-7 4-10 10-5l43 34c20-5 42-5 62 0l43-34c6-5 10-2 10 5l-1 65c13 16 17 32 14 51-4 33-33 57-97 57S67 192 63 159c-3-19 1-35 14-51Z" fill="#23352E"/>
  <path d="m89 56 3 42 24-18-27-24Zm142 0-27 24 24 18 3-42Z" fill="#52674B"/>
  <path d="M105 98c16-9 36-13 56-13" stroke="#3C5142" stroke-width="5" stroke-linecap="round"/>
  <path d="M72 159c3 20 18 34 39 42" stroke="#31483B" stroke-width="4" stroke-linecap="round"/>
'''

INSTRUMENT = '''  <g data-part="kalimba">
    <rect x="121" y="232" width="77" height="63" rx="14" fill="#B98F5D"/>
    <rect x="124" y="230" width="71" height="60" rx="12" fill="#D7B57D"/>
    <path d="M133 278c14 4 39 4 53 0" stroke="#C8A26D" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="159.5" cy="271" r="8.5" fill="#9C774B"/>
    <circle cx="159.5" cy="271" r="5.5" fill="#7B6243"/>
    <path d="M135 242h49" stroke="#95754C" stroke-width="5" stroke-linecap="round"/>
    <path d="M138 237v15m8-15v20m8-20v24m8-24v27m8-27v23m8-23v18" stroke="#F5F0D8" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M135 241h49" stroke="#65735B" stroke-width="3" stroke-linecap="round"/>
  </g>
'''

EYES = {
    "open": '''  <g data-part="eyes">
    <path d="M92 132c3-12 12-19 25-19 14 0 24 9 26 23-5 13-14 20-27 19-13-1-22-9-24-23Z" fill="#B8DB8C"/>
    <path d="M177 136c2-14 12-23 26-23 13 0 22 7 25 19-2 14-11 22-24 23-13 1-22-7-27-19Z" fill="#B8DB8C"/>
    <ellipse cx="121" cy="134" rx="7" ry="17" fill="#1F352B"/><ellipse cx="199" cy="134" rx="7" ry="17" fill="#1F352B"/>
    <circle cx="124" cy="127" r="3" fill="#FAF9E7"/><circle cx="202" cy="127" r="3" fill="#FAF9E7"/>
  </g>''',
    "half": '''  <g data-part="eyes">
    <path d="M93 135h50c-4 13-14 20-27 19-12-1-20-7-23-19Zm84 0h50c-3 12-11 18-23 19-13 1-23-6-27-19Z" fill="#B8DB8C"/>
    <path d="M115 137v8c0 5 3 8 6 8s6-3 6-8v-8m66 0v8c0 5 3 8 6 8s6-3 6-8v-8" fill="#1F352B"/>
    <path d="M92 134h51m34 0h51" stroke="#1B2C25" stroke-width="4" stroke-linecap="round"/>
  </g>''',
    "closed": '''  <g data-part="eyes" stroke="#B8DB8C" stroke-width="4.5" stroke-linecap="round">
    <path d="M97 137c11 10 28 11 41 0m44 0c13 11 30 10 41 0"/>
  </g>''',
    "happy": '''  <g data-part="eyes" stroke="#B8DB8C" stroke-width="5" stroke-linecap="round">
    <path d="M97 140c9-14 29-14 40 0m46 0c11-14 31-14 40 0"/>
  </g>''',
}

PAWS = {
    "hold": '''  <g data-part="paws" fill="#23352E">
    <path d="M111 232c-10 1-16 9-13 17 3 9 16 10 26 4l12-8c5-4 3-11-3-12l-22-1Z"/>
    <path d="M208 232c10 1 16 9 13 17-3 9-16 10-26 4l-12-8c-5-4-3-11 3-12l22-1Z"/>
  </g>
  <path d="m121 242 6 2m66 0 6-2" stroke="#617453" stroke-width="2.5" stroke-linecap="round"/>''',
    "ready": '''  <g data-part="paws" fill="#23352E">
    <path d="M111 232c-10 1-16 9-13 17 3 9 16 10 26 4l12-8c5-4 3-11-3-12l-22-1Z"/>
    <path d="M207 230c10 0 16 7 14 15-2 9-14 10-24 4l-11-8c-5-4-2-10 4-11h17Z"/>
  </g>
  <path d="m121 242 6 2m68-4 6 2" stroke="#617453" stroke-width="2.5" stroke-linecap="round"/>
  <g data-part="music-note" stroke="#7F9D65" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M268 106V85l11-3v21"/><ellipse cx="264" cy="107" rx="5" ry="3" fill="#7F9D65" stroke="none"/><ellipse cx="275" cy="104" rx="5" ry="3" fill="#7F9D65" stroke="none"/>
  </g>''',
    "wave": '''  <g data-part="paws" fill="#23352E">
    <path d="M111 232c-10 1-16 9-13 17 3 9 16 10 26 4l12-8c5-4 3-11-3-12l-22-1Z"/>
    <path d="M208 229c-4-8-4-18 2-29l23-38c3-5 6-11 12-12 7-2 11 3 10 9 7-4 13 1 11 7 8 0 10 7 5 13l-21 24c-9 13-13 25-21 29-8 4-16 3-21-3Z"/>
  </g>
  <path d="m121 242 6 2" stroke="#617453" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse data-part="paw-pad" cx="249" cy="179" rx="9" ry="7" transform="rotate(-37 249 179)" fill="#8EA77A"/>
  <g data-part="wave-marks" stroke="#9DAF83" stroke-width="3" stroke-linecap="round"><path d="m278 143 5-6m-1 22 8-1m-24-31 1-7"/></g>''',
}


def frame(filename, title, description, eyes="open", paws="hold", happy=False):
    mouth = '<path data-part="mouth" d="M151 172q9 9 18 0" stroke="#B6C5A7" stroke-width="2.5" stroke-linecap="round"/>' if happy else '<path data-part="mouth" d="m155 171 5 4 5-4" stroke="#B6C5A7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
    nose = '<path d="m157 163 3 2 3-2" stroke="#748A68" stroke-width="2" stroke-linecap="round"/>'
    contents = HEADER.format(title=title, description=description) + BODY + EYES[eyes] + "\n  " + nose + "\n  " + mouth + "\n" + INSTRUMENT + PAWS[paws] + "\n</svg>\n"
    (ROOT / filename).write_text(contents, encoding="utf-8")


frame("companion-idle.svg", "小黑陪练 · 睁眼", "坐好，睁眼，双爪抱琴。")
frame("companion-blink-half.svg", "小黑陪练 · 半闭眼", "身体保持不动，眼睛半闭。", eyes="half")
frame("companion-blink.svg", "小黑陪练 · 闭眼", "身体保持不动，眼睛闭合。", eyes="closed")
frame("companion-ready.svg", "小黑陪练 · 准备弹奏", "右爪轻移到琴键上，耳边出现一个音符。", paws="ready")
frame("companion-wave.svg", "小黑陪练 · 举爪庆祝", "身体保持不动，笑着举起右爪。", eyes="happy", paws="wave", happy=True)
frame("companion-rest.svg", "小黑陪练 · 安静休息", "闭眼微笑，双爪抱琴休息。", eyes="closed", happy=True)
