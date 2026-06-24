const categories = [
  { name: "饭搭子", count: "328 个邀约", tone: "coral" },
  { name: "运动搭子", count: "216 个邀约", tone: "green" },
  { name: "学习搭子", count: "184 个邀约", tone: "blue" },
  { name: "出游搭子", count: "97 个邀约", tone: "gold" }
];

const partners = [
  {
    title: "今晚下班后约一顿川菜",
    meta: "徐汇 · 19:30 · 2 人",
    tags: ["火锅", "不拼酒", "AA"],
    description: "想找附近同频的人一起吃饭，偏好安静一点的店。"
  },
  {
    title: "周六滨江慢跑 5 公里",
    meta: "浦东滨江 · 周六 08:00",
    tags: ["慢跑", "新手友好", "固定搭子"],
    description: "配速 7 分左右，跑后可以一起买咖啡。"
  },
  {
    title: "React 面试刷题自习",
    meta: "线上/静安 · 工作日晚间",
    tags: ["前端", "监督", "资料共享"],
    description: "每晚 1 小时互相打卡，目标两周完成核心题库。"
  }
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#">
          同城搭子
        </a>
        <nav className="nav-links" aria-label="主导航">
          <a href="#categories">分类</a>
          <a href="#recommended">推荐</a>
          <a href="#publish">发布需求</a>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">City Partner</p>
          <h1>找到今天就能见面的同城搭子</h1>
          <p className="hero-text">
            从一顿饭、一场运动到一次自习，把临时想做的事变成靠谱邀约。
          </p>
          <div className="hero-actions" id="publish">
            <a className="primary-button" href="#publish-form">
              发布需求
            </a>
            <a className="secondary-button" href="#recommended">
              浏览推荐
            </a>
          </div>
        </div>
        <div className="hero-panel" aria-label="今日同城动态">
          <span>今日新增</span>
          <strong>86</strong>
          <p>个同城邀约正在等待回应</p>
        </div>
      </section>

      <section className="section" id="categories">
        <div className="section-heading">
          <p className="eyebrow">分类入口</p>
          <h2>按想做的事找搭子</h2>
        </div>
        <div className="category-grid">
          {categories.map((category) => (
            <a className={`category-card ${category.tone}`} href="#" key={category.name}>
              <span>{category.name}</span>
              <strong>{category.count}</strong>
            </a>
          ))}
        </div>
      </section>

      <section className="section" id="recommended">
        <div className="section-heading">
          <p className="eyebrow">推荐搭子</p>
          <h2>附近正在发起的邀约</h2>
        </div>
        <div className="partner-grid">
          {partners.map((partner) => (
            <article className="partner-card" key={partner.title}>
              <div>
                <p className="partner-meta">{partner.meta}</p>
                <h3>{partner.title}</h3>
                <p>{partner.description}</p>
              </div>
              <div className="tag-row">
                {partner.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="publish-band" id="publish-form">
        <div>
          <p className="eyebrow">快速发布</p>
          <h2>说清时间、地点和期待，系统会帮你展示给附近的人。</h2>
        </div>
        <button type="button">发布需求</button>
      </section>
    </main>
  );
}
