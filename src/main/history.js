'use strict';

// 질문·답변 기록. 사용자 데이터 폴더의 history.json 한 파일에 최근 것부터 저장한다.
// 기록 하나 = 공통 입력창으로 보낸 질문 한 번(라운드):
//   { id, at, question, targets: [id], answers: { [svcId]: { name, state, text } }, synth: [{ judge, at, text }] }

const fs = require('fs');
const path = require('path');

const MAX_RECORDS = 500;
const SAVE_DELAY_MS = 500;

let file = null;
let records = [];
let saveTimer = null;

function init(userDataDir) {
  file = path.join(userDataDir, 'history.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    records = Array.isArray(data) ? data : [];
  } catch {
    records = [];
  }
}

// 답변이 끝날 때마다 저장하므로 잠깐 모았다가 한 번에 쓴다.
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(file, JSON.stringify(records));
    } catch {}
  }, SAVE_DELAY_MS);
}

function add({ question, targets }) {
  const rec = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    question,
    targets,
    answers: {},
    synth: [],
  };
  records.unshift(rec);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  save();
  return rec.id;
}

const find = (id) => records.find((r) => r.id === id);

function setAnswer(id, svcId, answer) {
  const rec = find(id);
  if (!rec) return;
  rec.answers[svcId] = answer;
  save();
}

function addSynth(id, synth) {
  const rec = find(id);
  if (!rec) return;
  rec.synth.push(synth);
  save();
}

/** 목록용 요약. query가 있으면 질문·답변 글에서 찾는다 (대소문자 무시). */
function list(query = '') {
  const q = query.trim().toLowerCase();
  const hit = (r) =>
    !q ||
    r.question.toLowerCase().includes(q) ||
    Object.values(r.answers).some((a) => (a.text || '').toLowerCase().includes(q)) ||
    r.synth.some((s) => (s.text || '').toLowerCase().includes(q));
  return records.filter(hit).map((r) => ({
    id: r.id,
    at: r.at,
    question: r.question.slice(0, 200),
    answered: Object.values(r.answers).filter((a) => a.text).length,
    targets: r.targets.length,
    synth: r.synth.length,
  }));
}

function get(id) {
  return find(id) || null;
}

function remove(id) {
  records = records.filter((r) => r.id !== id);
  save();
}

function clear() {
  records = [];
  save();
}

module.exports = { init, add, setAnswer, addSynth, list, get, remove, clear };
