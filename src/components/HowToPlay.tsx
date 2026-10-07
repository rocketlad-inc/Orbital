// ============================================================
// HowToPlay — the "HOW TO PLAY" tab on the landing page.
//
// Written for someone who has never seen the game. Rules:
//   - Plain language. No jargon before it's explained.
//   - Every concept earns a picture. The screenshots are real
//     renderer output (public/howto/*.jpg) — captured by driving
//     the actual map renderer, not mockups.
//   - Ordered as a first session actually goes: what am I looking
//     at → what do I do first → how do I grow → how do I fight →
//     how do I win.
// ============================================================

import React from 'react';
import { t } from '../i18n/core';
import { tMarkup } from '../i18n/rich';
import { useI18n } from '../i18n/react';
import './HowToPlay.css';

interface Props {
  onSignIn: () => void;
}

/** One numbered teaching beat: picture on one side, words on the other.
 *  Most beats carry a real screenshot (`img`). Trade and the senate live
 *  in DOM panels rather than on the map canvas, so those two carry a
 *  labelled diagram (`diagram`) instead — drawn as a diagram on purpose,
 *  not dressed up to look like a screenshot it isn't. */
const Beat: React.FC<{
  n: number;
  title: string;
  img?: string;
  alt?: string;
  diagram?: React.ReactNode;
  flip?: boolean;
  children: React.ReactNode;
}> = ({ n, title, img, alt, diagram, flip, children }) => {
  useI18n();
  return (
    <section className={`htp-beat${flip ? ' htp-beat--flip' : ''}`}>
      <figure className="htp-shot">
        {img
          ? <img src={img} alt={alt} loading="lazy" width={1200} height={675} />
          : diagram}
      </figure>
      <div className="htp-copy">
        <div className="htp-step">{t('howto.step', { n })}</div>
        <h3 className="htp-beat-title">{title}</h3>
        {children}
      </div>
    </section>
  );
};

const SVG_W = 640;
const SVG_H = 360;

/** Trade: two empires swapping goods, hauled physically by freighter. */
const TradeDiagram = () => {
  useI18n();
  return (
  <svg
    className="htp-diagram"
    viewBox={`0 0 ${SVG_W} ${SVG_H}`}
    role="img"
    aria-label={t('howto.trade.aria')}
  >
    <rect width={SVG_W} height={SVG_H} fill="#080d14" />
    {/* your world */}
    <g transform="translate(96,180)">
      <circle r={44} fill="rgba(78,205,196,0.18)" stroke="#4ecdc4" strokeWidth={1.8} />
      <path d="M-20 6 Q-8 -14 10 -5 Q22 3 17 14 Q0 25 -14 18 Z" fill="rgba(110,231,183,0.5)" />
      <text y={70} textAnchor="middle" fill="#4ecdc4" fontSize={13} fontWeight={700} letterSpacing={2}>{t('howto.you')}</text>
    </g>
    {/* their world */}
    <g transform="translate(544,180)">
      <circle r={44} fill="rgba(255,138,77,0.16)" stroke="#ff8a4d" strokeWidth={1.8} />
      <path d="M-18 4 Q-6 -13 12 -6 Q23 2 17 13 Q0 24 -13 16 Z" fill="rgba(255,179,122,0.45)" />
      <text y={70} textAnchor="middle" fill="#ff8a4d" fontSize={13} fontWeight={700} letterSpacing={2}>{t('howto.them')}</text>
    </g>

    {/* outbound leg — label sits ABOVE the lane so it never sits on the
        dashes, and the freighter rides the lane it's actually hauling. */}
    <g>
      <path d="M150 128 H470" stroke="#4ecdc4" strokeWidth={2} strokeDasharray="7 6" fill="none" opacity={0.7} />
      <path d="M470 128 l-12 -6 v12 z" fill="#4ecdc4" />
      <g transform="translate(238,128)">
        <rect x={-46} y={-30} width={92} height={22} rx={4}
          fill="rgba(78,205,196,0.16)" stroke="#4ecdc4" strokeWidth={1.2} />
        <text y={-14} textAnchor="middle" fill="#d8f5f2" fontSize={12} fontWeight={700}>{t('howto.trade.metal', { n: 500 })}</text>
      </g>
      <g transform="translate(384,128)">
        <rect x={-17} y={-9} width={34} height={18} rx={3}
          fill="rgba(127,212,255,0.4)" stroke="#7fd4ff" strokeWidth={1.4} />
        <path d="M-17 -3 L-27 0 L-17 3 Z" fill="#ff9e4a" />
      </g>
    </g>

    {/* return leg */}
    <g>
      <path d="M470 232 H150" stroke="#ff8a4d" strokeWidth={2} strokeDasharray="7 6" fill="none" opacity={0.7} />
      <path d="M150 232 l12 -6 v12 z" fill="#ff8a4d" />
      <g transform="translate(392,232)">
        <rect x={-52} y={8} width={104} height={22} rx={4}
          fill="rgba(255,138,77,0.14)" stroke="#ff8a4d" strokeWidth={1.2} />
        <text y={24} textAnchor="middle" fill="#ffd9c2" fontSize={12} fontWeight={700}>{t('howto.trade.science', { n: 300 })}</text>
      </g>
      <g transform="translate(246,232)">
        <rect x={-17} y={-9} width={34} height={18} rx={3}
          fill="rgba(127,212,255,0.4)" stroke="#7fd4ff" strokeWidth={1.4} />
        <path d="M17 -3 L27 0 L17 3 Z" fill="#ff9e4a" />
      </g>
    </g>

    {/* the caption that carries the actual lesson */}
    <text x={SVG_W / 2} y={182} textAnchor="middle" fill="#ff8080" fontSize={12} letterSpacing={0.6}>
      {t('howto.trade.raided')}
    </text>

    <text x={SVG_W / 2} y={30} textAnchor="middle" fill="#8fa8bf" fontSize={11.5} letterSpacing={2}>
      {t('howto.trade.delivered')}
    </text>
    {/* tariff — centred at the foot, clear of the world labels */}
    <text x={SVG_W / 2} y={322} textAnchor="middle" fill="#c4b5fd" fontSize={11} letterSpacing={0.6}>
      {t('howto.trade.tariff')}
    </text>
  </svg>
  );
};

/** Senate: weighted votes on a bill that rebinds the rules for everyone. */
const SenateDiagram = () => {
  useI18n();
  return (
  <svg
    className="htp-diagram"
    viewBox={`0 0 ${SVG_W} ${SVG_H}`}
    role="img"
    aria-label={t('howto.senate.aria')}
  >
    <rect width={SVG_W} height={SVG_H} fill="#080d14" />

    {/* the bill */}
    <g transform="translate(320,56)">
      <rect x={-160} y={-30} width={320} height={56} rx={6}
        fill="rgba(196,181,253,0.10)" stroke="#c4b5fd" strokeWidth={1.5} />
      <text y={-10} textAnchor="middle" fill="#c4b5fd" fontSize={10.5} letterSpacing={2.4}>{t('howto.senate.bill')}</text>
      <text y={13} textAnchor="middle" fill="#efeaff" fontSize={15} fontWeight={700}>{t('howto.senate.yield')}</text>
    </g>

    {/* voters, sized by weight */}
    <text x={320} y={116} textAnchor="middle" fill="#8fa8bf" fontSize={11} letterSpacing={1.6}>
      {t('howto.senate.weight')}
    </text>
    {[
      { x: 128, name: t('howto.you'), w: 4, col: '#4ecdc4', vote: 'YEA' },
      { x: 320, name: t('howto.senate.rival'), w: 3, col: '#ff8a4d', vote: 'NAY' },
      { x: 512, name: t('howto.senate.third'), w: 2, col: '#ffd27a', vote: 'YEA' },
    ].map(v => (
      <g key={v.name} transform={`translate(${v.x},170)`}>
        <circle r={26} fill={`${v.col}22`} stroke={v.col} strokeWidth={1.6} />
        <text y={5} textAnchor="middle" fill={v.col} fontSize={16} fontWeight={800}>×{v.w}</text>
        <text y={44} textAnchor="middle" fill={v.col} fontSize={11} fontWeight={700} letterSpacing={1.4}>{v.name}</text>
        <text y={59} textAnchor="middle" fill={v.vote === 'YEA' ? '#7fffa1' : '#ff8080'} fontSize={10.5} letterSpacing={1.2}>{v.vote === 'YEA' ? t('howto.senate.yea') : t('howto.senate.nay')}</text>
      </g>
    ))}

    {/* tally */}
    <g transform="translate(320,268)">
      <text y={-12} textAnchor="middle" fill="#8fa8bf" fontSize={10.5} letterSpacing={1.6}>{t('howto.senate.tally')}</text>
      <rect x={-160} y={0} width={320} height={16} rx={4} fill="rgba(255,255,255,0.06)" />
      {/* 6 yea of 9 total */}
      <rect x={-160} y={0} width={213} height={16} rx={4} fill="rgba(127,255,161,0.45)" />
      <text x={-150} y={12} fill="#0a1a10" fontSize={11} fontWeight={800}>{t('howto.senate.yeaN', { n: 6 })}</text>
      <text x={150} y={12} textAnchor="end" fill="#ffb0b0" fontSize={11} fontWeight={800}>{t('howto.senate.nayN', { n: 3 })}</text>
    </g>

    {/* outcome */}
    <text x={320} y={318} textAnchor="middle" fill="#7fffa1" fontSize={12.5} fontWeight={700} letterSpacing={1.2}>
      {t('howto.senate.passed')}
    </text>
    <text x={320} y={340} textAnchor="middle" fill="#64809c" fontSize={10.5}>
      {t('howto.senate.majority')}
    </text>
  </svg>
  );
};

export const HowToPlay: React.FC<Props> = ({ onSignIn }) => {
  useI18n();
  return (
  <div className="htp">
    <header className="htp-hero">
      <div className="htp-eyebrow">{t('howto.eyebrow')}</div>
      <h1 className="htp-title">{t('howto.title')}</h1>
      <p className="htp-lede">
        {t('howto.lede')}
      </p>
      <div className="htp-facts">
        <div className="htp-fact">
          <b>{t('howto.fact1.b')}</b>
          <span>{t('howto.fact1.s')}</span>
        </div>
        <div className="htp-fact">
          <b>{t('howto.fact2.b')}</b>
          <span>{t('howto.fact2.s')}</span>
        </div>
        <div className="htp-fact">
          <b>{t('howto.fact3.b')}</b>
          <span>{t('howto.fact3.s')}</span>
        </div>
      </div>
    </header>

    <Beat
      n={1}
      title={t('howto.b1.title')}
      img="/howto/map-system.jpg"
      alt={t('howto.b1.alt')}
    >
      <p>{tMarkup('howto.b1.p1')}</p>
      <p>{tMarkup('howto.b1.p2')}</p>
    </Beat>

    <Beat
      n={2}
      title={t('howto.b2.title')}
      img="/howto/map-world.jpg"
      alt={t('howto.b2.alt')}
      flip
    >
      <p>{tMarkup('howto.b2.p1')}</p>
      <p>{tMarkup('howto.b2.p2')}</p>
    </Beat>

    <Beat
      n={3}
      title={t('howto.b3.title')}
      img="/howto/map-terraform.jpg"
      alt={t('howto.b3.alt')}
    >
      <p>{tMarkup('howto.b3.p1')}</p>
      <p>{tMarkup('howto.b3.p2')}</p>
    </Beat>

    <Beat
      n={4}
      title={t('howto.b4.title')}
      diagram={<TradeDiagram />}
      flip
    >
      <p>{tMarkup('howto.b4.p1')}</p>
      <p>{tMarkup('howto.b4.p2')}</p>
    </Beat>

    <Beat
      n={5}
      title={t('howto.b5.title')}
      img="/howto/map-battle.jpg"
      alt={t('howto.b5.alt')}
    >
      <p>{tMarkup('howto.b5.p1')}</p>
      <p>{tMarkup('howto.b5.p2')}</p>
    </Beat>

    <Beat
      n={6}
      title={t('howto.b6.title')}
      diagram={<SenateDiagram />}
      flip
    >
      <p>{tMarkup('howto.b6.p1')}</p>
      <p>{tMarkup('howto.b6.p2')}</p>
      <p>{tMarkup('howto.b6.p3')}</p>
    </Beat>

    <Beat
      n={7}
      title={t('howto.b7.title')}
      img="/howto/map-dyson.jpg"
      alt={t('howto.b7.alt')}
    >
      <p>{tMarkup('howto.b7.p1')}</p>
      <p>{tMarkup('howto.b7.p2')}</p>
      <p>{tMarkup('howto.b7.p3')}</p>
    </Beat>

    <section className="htp-quick">
      <h2 className="htp-h2">{t('howto.quick.title')}</h2>
      <ol className="htp-list">
        <li>{tMarkup('howto.quick.1')}</li>
        <li>{tMarkup('howto.quick.2')}</li>
        <li>{tMarkup('howto.quick.3')}</li>
        <li>{tMarkup('howto.quick.4')}</li>
        <li>{tMarkup('howto.quick.5')}</li>
        <li>{tMarkup('howto.quick.6')}</li>
      </ol>
      <p className="htp-note">
        {t('howto.quick.note')}
      </p>
    </section>

    <section className="htp-faq">
      <h2 className="htp-h2">{t('howto.faq.title')}</h2>
      <dl>
        <dt>{t('howto.faq.q1')}</dt>
        <dd>
          {t('howto.faq.a1')}
        </dd>

        <dt>{t('howto.faq.q2')}</dt>
        <dd>
          {t('howto.faq.a2')}
        </dd>

        <dt>{t('howto.faq.q3')}</dt>
        <dd>
          {t('howto.faq.a3')}
        </dd>

        <dt>{t('howto.faq.q4')}</dt>
        <dd>
          {t('howto.faq.a4')}
        </dd>

        <dt>{t('howto.faq.q5')}</dt>
        <dd>
          {t('howto.faq.a5')}
        </dd>

        <dt>{t('howto.faq.q6')}</dt>
        <dd>
          {t('howto.faq.a6')}
        </dd>
      </dl>
    </section>

    <section className="htp-cta">
      <h2 className="htp-h2">{t('howto.cta.title')}</h2>
      <button className="cta-primary cta-large" onClick={onSignIn}>
        {t('howto.cta.button')}
      </button>
      <div className="htp-cta-sub">{t('howto.cta.sub')}</div>
    </section>
  </div>
  );
};
