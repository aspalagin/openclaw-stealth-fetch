import pytest
from stealth_fetch.extract import extract, extract_serp, serp_engine, _markdownify

ENGINES = [
    ("yandex", "https://yandex.ru/search/?text=example", '<li class="serp-item"><h2><a href="https://example.org/">Example result</a></h2><div class="OrganicText">Example snippet</div></li>'),
    ("google", "https://www.google.com/search?q=example", '<div class="g"><a href="https://example.org/"><h3>Example result</h3></a><div class="VwiC3b">Example snippet</div></div>'),
    ("bing", "https://www.bing.com/search?q=example", '<li class="b_algo"><h2><a href="https://example.org/">Example result</a></h2><div class="b_caption"><p>Example snippet</p></div></li>'),
    ("ddg", "https://html.duckduckgo.com/html/?q=example", '<div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F">Example result</a><span class="result__snippet">Example snippet</span></div>'),
]
@pytest.mark.parametrize("engine,url,body", ENGINES)
@pytest.mark.parametrize("mode", ["markdown","text"])
def test_synthetic_serp(engine, url, body, mode):
    assert serp_engine(url) == engine
    html = '<html><title>Example search</title><body>' + body + '</body></html>'
    results = extract_serp(html,url,engine)
    assert results == [{"title":"Example result","url":"https://example.org/","snippet":"Example snippet"}]
    ex = extract(html,url,mode)
    assert ex.extractor == "serp" and "Example result" in ex.text
    assert ("**" in ex.text) == (mode == "markdown")

@pytest.mark.parametrize("mode", ["markdown","text"])
def test_synthetic_article(mode):
    html = '<html><title>Example article</title><article><h1>Example article</h1><p>' + 'This is synthetic article content for extraction tests. ' * 60 + '</p></article></html>'
    ex = extract(html,"https://example.com/article",mode)
    assert len(ex.text) > 500 and ex.title == "Example article"

def test_markdown_converter_preserves_structure():
    result = _markdownify('<h1>Heading</h1><p>A <a href="https://example.com/">link</a>.</p><ul><li>One</li><li>Two</li></ul>',"markdown")
    assert '# Heading' in result and '[link](https://example.com/)' in result
    assert 'One' in result and 'Two' in result

def test_converter_removes_noncontent():
    html = '<p>Visible</p><script>hidden_script</script><style>hidden_style</style><img src="https://example.com/image">'
    for mode in ['markdown','text']:
        result = _markdownify(html,mode)
        assert 'Visible' in result and 'hidden_' not in result and 'image' not in result

def test_text_converter_drops_link_markup():
    assert _markdownify('<p>A <a href="https://example.com/">link</a>.</p>',"text") == 'A link .'

def test_readability_fallback(monkeypatch):
    import trafilatura
    monkeypatch.setattr(trafilatura,"extract",lambda *a, **k: None)
    html = '<html><title>Example article</title><article><p>' + 'Synthetic content with useful information. ' * 30 + '</p></article></html>'
    result = extract(html,'https://example.com/','markdown')
    assert result.extractor == 'readability' and len(result.text) > 100

def test_raw_fallback(monkeypatch):
    import trafilatura, readability
    monkeypatch.setattr(trafilatura,"extract",lambda *a, **k: None)
    class Broken:
        def __init__(self,*a,**k): raise ValueError('synthetic failure')
    monkeypatch.setattr(readability,'Document',Broken)
    result = extract('<h1>Heading</h1><p>Example text</p>','https://example.com/','markdown')
    assert result.extractor == 'raw' and '# Heading' in result.text
