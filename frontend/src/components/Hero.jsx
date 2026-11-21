// Home page welcome: what a committee is, in one look.
function MiniFigure({ x, y, cheer, delay }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="figure" style={{ "--delay": delay }}>
        <ellipse className="shadow" cx="0" cy="17" rx="20" ry="4.5" />
        <rect className="stool" x="-13" y="2" width="26" height="6" rx="3" />
        <g className={`body ${cheer ? "" : ""}`}>
          <path className="limb" d="M0 -22 L0 -3" />
          <path className="limb" d={cheer ? "M0 -17 L-13 -33 M0 -17 L13 -33" : "M0 -17 L-11 -8 M0 -17 L11 -8"} />
          <path className="limb" d="M0 -3 L-8 3 L-8 13 M0 -3 L8 3 L8 13" />
          <circle className="head" cx="0" cy="-30" r="8.5" />
        </g>
      </g>
    </g>
  );
}

export default function Hero() {
  return (
    <section className="hero">
      <div>
        <h1>Save together. Nobody holds the pot.</h1>
        <p className="lede">
          A committee where everyone pays the same amount each round and one member takes the whole pot, in a fairly drawn order.
          The smart contract keeps the money and a deposit covers anyone who stops paying.
        </p>
        <div className="cta">
          <a className="btn primary big" href="#/organize">Start a circle</a>
          <a className="btn big" href="#/mine">My circles</a>
        </div>
        <ol className="hero-steps">
          <li>Join with a deposit</li>
          <li>Pay every round</li>
          <li>Take the pot on your turn</li>
        </ol>
      </div>
      <div className="hero-art table-scene" aria-hidden="true">
        <svg viewBox="0 0 360 290">
          <ellipse cx="180" cy="150" rx="168" ry="128" className="rug" />
          <circle cx="180" cy="140" r="74" className="table-rim" />
          <circle cx="180" cy="140" r="66" fill="#f3f1ff" className="table-top" />
          <g transform="translate(180 128)">
            {[-24, -8, 8, 24].map((dx, i) => <ellipse key={dx} className="coin in" cx={dx} cy="0" rx="10" ry="5" style={{ animationDelay: `${i * 0.3}s` }} />)}
            <ellipse className="coin in" cx="-16" cy="-8" rx="10" ry="5" />
            <ellipse className="coin in" cx="0" cy="-8" rx="10" ry="5" />
            <ellipse className="coin in" cx="16" cy="-8" rx="10" ry="5" />
          </g>
          <text x="180" y="166" textAnchor="middle" className="centre-small">pot</text>
          <MiniFigure x={180} y={46} cheer delay="0s" />
          <g transform="translate(180 4)"><path className="star" d="M0 -9 L2.6 -2.8 L9 -2.8 L3.9 1.3 L5.7 7.8 L0 3.9 L-5.7 7.8 L-3.9 1.3 L-9 -2.8 L-2.6 -2.8 Z" /></g>
          <MiniFigure x={300} y={150} delay="0.4s" />
          <MiniFigure x={180} y={252} delay="0.8s" />
          <MiniFigure x={60} y={150} delay="1.2s" />
          <g transform="translate(296 92)"><g className="bubble paid"><rect width="52" height="20" rx="10" /><text x="26" y="14" textAnchor="middle">Paid ✓</text></g></g>
          <g transform="translate(14 92)"><g className="bubble due"><rect width="56" height="20" rx="10" /><text x="28" y="14" textAnchor="middle">Not yet</text></g></g>
        </svg>
      </div>
    </section>
  );
}
