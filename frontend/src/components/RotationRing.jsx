// The committee table: everyone sits around one round table, the pot is in the middle.
//
//   * Seats follow the payout order once it is drawn; figures slide to their new seats.
//   * A bubble beside each person says where they stand this round:
//       Paid ✓ (green), Not yet … (amber), Missed! (red); in the draw: Sealed / Revealed.
//   * The person receiving this round's pot raises their arms under a star.
//   * A gold coin by the stool means that person has already received a pot.
//   * When someone pays, a coin flies from their seat into the pot.
//   * Confetti when the circle completes. All motion stops if the system asks for reduced motion.
import { useEffect, useRef, useState } from "react";
import { money, same } from "../lib/format.js";

const W = 680;
const H = 650;
const CX = W / 2;
const CY = H / 2 - 6;
const TABLE_R = 120;
const SEAT_R = 218;

function Figure({ pose, faded }) {
  // Drawn around (0, 0) = the seat. Head at the top, stool at the bottom.
  const arms =
    pose === "cheer"
      ? "M0 -17 L-13 -33 M0 -17 L13 -33"
      : pose === "slump"
        ? "M0 -15 L-9 -4 M0 -15 L9 -4"
        : "M0 -17 L-11 -8 M0 -17 L11 -8";
  return (
    <g className={`figure ${pose} ${faded ? "faded" : ""}`}>
      <ellipse className="shadow" cx="0" cy="17" rx="22" ry="5" />
      <rect className="stool" x="-14" y="2" width="28" height="6" rx="3" />
      <path className="stool-legs" d="M-10 8 L-12 16 M10 8 L12 16" />
      <g className="body">
        <path className="limb" d="M0 -22 L0 -3" />
        <path className="limb" d={arms} />
        <path className="limb" d="M0 -3 L-8 3 L-8 13 M0 -3 L8 3 L8 13" />
        <circle className="head" cx="0" cy={pose === "slump" ? -27 : -30} r="8.5" />
      </g>
    </g>
  );
}

function Bubble({ kind, side }) {
  const text = { paid: "Paid ✓", due: "Not yet", late: "Missed!", sealed: "Sealed", revealed: "Revealed", waiting: "Commit?" }[kind];
  if (!text) return null;
  const w = kind === "revealed" ? 66 : 58;
  const x = side > 0 ? 18 : -18 - w;
  return (
    <g transform={`translate(${x} -52)`}>
     <g className={`bubble ${kind}`}>
      <rect width={w} height="22" rx="11" />
      <path d={side > 0 ? "M6 20 L2 28 L14 20 Z" : `M${w - 6} 20 L${w - 2} 28 L${w - 14} 20 Z`} />
      <text x={w / 2} y="15" textAnchor="middle">{text}</text>
     </g>
    </g>
  );
}

export default function RotationRing({ c, nameOf, account }) {
  const ordered = c.order.length ? c.order : c.members.map((m) => m.address);
  const seatsTotal = Math.max(c.groupSize, ordered.length);
  const people = Array.from({ length: seatsTotal }, (_, i) => ordered[i] || null);
  const info = Object.fromEntries(c.members.map((m) => [m.address, m]));
  const received = new Set(c.rounds.filter((r) => r.settled).map((r) => r.recipient));
  const closed = c.state === 2 && c.now > c.roundDeadline;
  const compact = seatsTotal > 8;
  const scale = compact ? Math.max(0.75, 10 / seatsTotal + 0.2) : 1.45;

  const seatPos = (i) => {
    const a = (2 * Math.PI * i) / seatsTotal - Math.PI / 2;
    return { x: CX + SEAT_R * Math.cos(a), y: CY + SEAT_R * Math.sin(a) + 10, a };
  };

  // Coins that fly into the pot when someone's payment shows up.
  const prevPaid = useRef(null);
  const [flights, setFlights] = useState([]);
  useEffect(() => {
    const paidNow = new Set(c.members.filter((m) => m.paidThisRound).map((m) => m.address));
    const key = `${c.address}:${c.currentRound}`;
    if (prevPaid.current && prevPaid.current.key === key) {
      const fresh = [...paidNow].filter((a) => !prevPaid.current.set.has(a));
      if (fresh.length) {
        const now = Date.now();
        setFlights((f) => [...f, ...fresh.map((a) => ({ id: `${a}-${now}`, from: people.indexOf(a) }))].slice(-12));
        setTimeout(() => setFlights((f) => f.filter((x) => !x.id.endsWith(`-${now}`))), 1300);
      }
    }
    prevPaid.current = { key, set: paidNow };
  }); // runs after every refresh of live data

  const participants = c.members.filter((m) => m.position > 0 && !m.removed);
  const paidCount = participants.filter((m) => m.paidThisRound).length;
  const potSlots = c.state === 2 ? participants.length : 0;

  const centre = (() => {
    if (c.state === 0) return { big: `${c.memberCount} of ${c.groupSize}`, small: "seats taken" };
    if (c.state === 1) return { big: "Drawing", small: `${c.draw.revealCount} of ${c.draw.memberCount} revealed` };
    if (c.state === 2) return { big: `Round ${c.currentRound}`, small: `of ${c.participantCount}, pot ${money(BigInt(c.contribution) * BigInt(c.participantCount))}` };
    if (c.state === 3) return { big: "Complete!", small: `${c.participantCount} pots paid out` };
    return { big: "Cancelled", small: "deposits refunded" };
  })();

  return (
    <figure className={`table-scene st${c.state}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Committee table: ${centre.big}, ${centre.small}`}>
        <defs>
          <radialGradient id="tableFill" cx="50%" cy="40%" r="65%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="var(--table)" />
          </radialGradient>
        </defs>

        {/* floor rug */}
        <ellipse cx={CX} cy={CY + 14} rx={SEAT_R + 56} ry={SEAT_R + 46} className="rug" />

        {/* table */}
        <circle cx={CX} cy={CY} r={TABLE_R + 10} className="table-rim" />
        <circle cx={CX} cy={CY} r={TABLE_R} fill="url(#tableFill)" className="table-top" />
        {c.state === 2 && c.currentRound > 1 && (
          <circle
            cx={CX} cy={CY} r={TABLE_R + 10} className="table-progress"
            strokeDasharray={`${(2 * Math.PI * (TABLE_R + 10) * (c.currentRound - 1)) / c.participantCount} ${2 * Math.PI * (TABLE_R + 10)}`}
            transform={`rotate(-90 ${CX} ${CY})`}
          />
        )}

        {/* the pot: one coin slot per participant, filled as they pay */}
        {c.state === 2 && (
          <g className="pot" transform={`translate(${CX} ${CY - 38})`}>
            {Array.from({ length: potSlots }, (_, i) => (
              <ellipse key={i} className={`coin ${i < paidCount ? "in" : ""}`} cx={((i % 5) - (Math.min(potSlots, 5) - 1) / 2) * 25} cy={-Math.floor(i / 5) * 13} rx="17" ry="8.5" />
            ))}
          </g>
        )}
        {c.state === 1 && (
          <g className="dice" transform={`translate(${CX} ${CY - 44})`}>
            {[-18, 18].map((dx, i) => (
              <g key={dx} transform={`translate(${dx} 0)`}>
                <g className={`die d${i}`}>
                  <rect x="-12" y="-12" width="24" height="24" rx="5" />
                  <circle cx="-5" cy="-5" r="2.3" />
                  <circle cx="5" cy="5" r="2.3" />
                  {i === 1 && <circle cx="0" cy="0" r="2.3" />}
                </g>
              </g>
            ))}
          </g>
        )}
        <text x={CX} y={CY + 16} textAnchor="middle" className="centre-big">{centre.big}</text>
        <text x={CX} y={CY + 40} textAnchor="middle" className="centre-small">{centre.small}</text>

        {/* seats */}
        {people.map((addr, i) => {
          const p = seatPos(i);
          const side = p.x >= CX - 1 ? 1 : -1;
          if (!addr) {
            return (
              <g key={`open-${i}`} className="seat open" style={{ transform: `translate(${p.x}px, ${p.y}px) scale(${scale})` }}>
                <ellipse className="shadow" cx="0" cy="17" rx="22" ry="5" />
                <rect className="stool empty" x="-14" y="2" width="28" height="6" rx="3" />
                <circle className="empty-head" cx="0" cy="-26" r="13" />
                <text className="plus" x="0" y="-21" textAnchor="middle">+</text>
                <text className="name" x="0" y="40" textAnchor="middle">Open seat</text>
              </g>
            );
          }
          const m = info[addr] || {};
          const isCurrent = c.state === 2 && same(addr, c.currentRecipient);
          const isMe = same(addr, account);
          const got = received.has(addr);
          let bubble = null;
          let pose = "sit";
          if (m.removed) pose = "slump";
          else if (c.state === 1) bubble = m.revealed ? "revealed" : m.committed ? "sealed" : "waiting";
          else if (c.state === 2 && m.position > 0) {
            bubble = m.paidThisRound ? "paid" : closed ? "late" : "due";
            if (closed && !m.paidThisRound) pose = "slump";
          }
          if (isCurrent || c.state === 3) pose = m.removed ? "slump" : "cheer";
          const label = nameOf(addr).replace(" (you)", "");
          const shortLabel = label.length > 12 ? label.slice(0, 11) + "…" : label;
          return (
            <g key={addr} className={`seat ${isCurrent ? "current" : ""} ${isMe ? "me" : ""} ${m.removed ? "removed" : ""}`}
              style={{ transform: `translate(${p.x}px, ${p.y}px) scale(${scale})`, "--delay": `${(i % 5) * 0.35}s` }}>
              {isCurrent && (
                <g transform="translate(0 -58)">
                  <path className="star" d="M0 -11 L3.2 -3.4 L11 -3.4 L4.8 1.6 L7 9.5 L0 4.8 L-7 9.5 L-4.8 1.6 L-11 -3.4 L-3.2 -3.4 Z" />
                </g>
              )}
              <Figure pose={pose} faded={m.removed || c.state === 4} />
              {c.order.length > 0 && !m.removed && (
                <g className="seat-no" transform={`translate(${-side * 20} -42)`}>
                  <circle r="8.5" />
                  <text y="3.6" textAnchor="middle">{i + 1}</text>
                </g>
              )}
              {got && (
                <g className="got" transform={`translate(${-side * 21} 6)`} aria-label="already received the pot">
                  <ellipse cx="0" cy="3" rx="8" ry="4" />
                  <ellipse cx="0" cy="-1" rx="8" ry="4" />
                </g>
              )}
              {!compact && bubble && <Bubble kind={bubble} side={side} />}
              {compact && bubble && <circle className={`dot-status ${bubble}`} cx="16" cy="-34" r="5" />}
              <g transform="translate(0 40)">
                <rect className={`name-pill ${isMe ? "me" : ""}`} x={-(shortLabel.length * 3.9 + 12)} y="-13" width={shortLabel.length * 7.8 + 24} height="20" rx="10" />
                <text className="name" textAnchor="middle" y="1">{shortLabel}</text>
              </g>
            </g>
          );
        })}

        {/* coins flying into the pot */}
        {flights.map((f) => {
          if (f.from < 0) return null;
          const p = seatPos(f.from);
          return (
            <ellipse key={f.id} className="flying-coin" rx="9" ry="4.5"
              style={{ "--sx": `${p.x}px`, "--sy": `${p.y - 20}px`, "--ex": `${CX}px`, "--ey": `${CY - 40}px` }} />
          );
        })}

        {/* confetti when the circle completes */}
        {c.state === 3 && (
          <g className="confetti" aria-hidden="true">
            {Array.from({ length: 28 }, (_, i) => (
              <rect key={i} x={CX - 220 + ((i * 157) % 440)} y={CY - 260} width="7" height="12" rx="2"
                className={`bit b${i % 4}`} style={{ "--d": `${(i % 7) * 0.18}s`, "--r": `${(i * 47) % 360}deg` }} />
            ))}
          </g>
        )}
      </svg>
      <figcaption className="legend">
        <span className="lg paid">Paid this round</span>
        <span className="lg due">Not yet</span>
        <span className="lg late">Missed</span>
        <span className="lg got">Already got the pot</span>
        <span className="lg lg-star">Receives this round</span>
      </figcaption>
    </figure>
  );
}
