// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/i18n-en-prompt.js)
// Text sent to the AIs — English (v0.31.0). Keys start with 'prompt.' and mirror i18n-ko-prompt.js.
// These are not UI strings: they are the requests the app writes for synthesis, analysis, debate, hand-off,
// skills, web page questions and project mode.
//
// When editing, keep the markers the answer readers look for (patch.js, analysis.js, project-context.js):
//   "File: path", "<<<<<<< SEARCH", ">>>>>>> REPLACE", DELETE_FILES, NEED_FILES, PLAN_FILES,
//   and the analysis headings (analysis.js SECTIONS).
(function (root, dict) {
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else {
    const s = ((root.MLA = root.MLA || {}).i18nStrings = root.MLA.i18nStrings || {});
    s.en = Object.assign(s.en || {}, dict);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  // ---------- common ----------
  'prompt.clipped': '…(truncated)',
  'prompt.origQuestion': '[Original question]',
  'prompt.noQuestion': '(no question)',
  'prompt.answerOf': "[{name}'s answer]",

  // ---------- hand-off (chain.js) ----------
  'prompt.handoff.intro': 'Here is an answer written by another AI ({name}).',
  'prompt.handoff.review': [
    'Please review the answer above carefully.',
    '1) Wrong or inaccurate parts (where and why)',
    '2) Important points it left out',
    '3) Claims with weak evidence or that need checking',
    '4) A better answer with those problems fixed',
  ].join('\n'),
  'prompt.handoff.counter': [
    'Please argue against the answer above.',
    '1) Its weakest reasoning, counterexamples and other viewpoints, with evidence',
    '2) Acknowledge the parts that are still right',
    '3) Your own conclusion after the rebuttal',
  ].join('\n'),
  'prompt.handoff.continue': [
    'Please pick up the answer above and take it further.',
    'Fill in missing steps, go deeper, or spell out what to do next. Do not repeat what is already written.',
  ].join('\n'),

  // ---------- debate (chain.js) ----------
  'prompt.debate.head': '[Debate round {round}/{rounds}] Other AIs answered the same question as shown below.',
  'prompt.debate.latestOf': "[{name}'s latest answer]",
  'prompt.debate.askSelf': 'Compare these with your ({name}) previous answer and do the following.',
  'prompt.debate.ask': 'Compare these with your previous answer and do the following.',
  'prompt.debate.steps': [
    '1) Rebut, specifically, what the other answers got wrong or supported weakly',
    '2) Accept what the other answers got right and correct your own answer',
    '3) Rewrite your revised position as a complete answer that a first-time reader can follow',
  ].join('\n'),
  'prompt.debate.role.pro': '[Your role: Pro] In this debate you defend the question\'s main claim or the most likely answer. Hold that position with evidence, but concede what the others get right.',
  'prompt.debate.role.con': '[Your role: Con] In this debate you argue against the answer that looks most likely. Build the strongest counter-case, without forcing a bad argument, and concede what the others get right.',
  'prompt.debate.role.rebut': '[Your role: Rebuttal only] Rather than giving a conclusion of your own, focus on finding weaknesses, counterexamples and missing assumptions in the other answers. If there is truly nothing to rebut, say so.',
  'prompt.debate.note': '[A note the user added during the debate]\n{note}\nPlease take it into account as well.',
  'prompt.debate.last': ' (this is the final round)',
  'prompt.judge.head': 'Several AIs debated the same question for {rounds} round(s), rebutting and improving on each other. Below is the final position of each AI.',
  'prompt.judge.finalOfRole': "[{name}'s ({role}) final position]",
  'prompt.judge.roleNote': 'The participating AIs were given debate roles (pro, con, rebuttal only). Judge by the soundness of the evidence, not by the role.',
  'prompt.judge.finalOf': "[{name}'s final position]",
  'prompt.judge.format': [
    'As the judge, summarize in exactly the format below. Do not rename or reorder the headings.',
    '',
    '## Points of agreement',
    '- What the participating AIs concluded in common (one per line)',
    '',
    '## Remaining disagreements',
    '- [Issue] each AI\'s position, which side is right and why (if none, write "- None")',
    '',
    '## Final answer',
    'The most accurate and complete final answer, reflecting the debate',
  ].join('\n'),

  // ---------- synthesis (synth.js) ----------
  'prompt.synth.head': 'Other AIs answered the same question as shown below.',
  'prompt.synth.ask': 'Compare the answers above and summarize the following.',
  'prompt.synth.askSelf': 'Compare the answers above with your previous answer and summarize the following.',
  'prompt.synth.steps': ['1) Errors or inaccurate parts', '2) Important points that some answers missed', '3) The most accurate and complete final answer'].join('\n'),
  'prompt.synth.code.head': 'Other AIs proposed the changes below for the same coding request.',
  'prompt.synth.code.ask': 'Compare the answers above and do the following.',
  'prompt.synth.code.askSelf': 'Compare the answers above with your previous answer and do the following.',
  'prompt.synth.code.steps': [
    '1) Briefly list the problems in each proposal (bugs, missing handling)',
    '2) Give a final proposal that combines the best parts — not as a diff: for every changed or new file, write a "File: path" line followed by one code block with the FULL content of that file (from the first line to the last, nothing omitted)',
    '   For an existing file longer than 150 lines, give only the parts to change instead, inside the same code block, as "<<<<<<< SEARCH" / (the current code, exactly) / "=======" / (the new code) / ">>>>>>> REPLACE" (so the answer does not get cut off)',
    '3) List files to delete on one line: DELETE_FILES: path1, path2',
  ].join('\n'),

  // ---------- analysis (synth.js — heading names must match analysis.js SECTIONS) ----------
  'prompt.analysis.head': 'Several AIs answered the same question as shown below.',
  'prompt.analysis.ask': [
    'Analyze where the answers agree and where they differ, and reply in exactly the format below.',
    'Do not rename or reorder the four headings (## Common ground, ## Disagreements, ## Weak evidence, ## Final answer), and write nothing before or after the format. Do not wrap the whole reply in a code block.',
  ].join('\n'),
  'prompt.analysis.self': 'Also compare the answer you ({name}) gave to the same question earlier, in a "{name}" column.',
  'prompt.analysis.common': ['## Common ground', '- What most of the AIs said in common (one per line)'].join('\n'),
  'prompt.analysis.disagree': '## Disagreements',
  'prompt.analysis.colTopic': 'Issue',
  'prompt.analysis.colVerdict': 'Verdict',
  'prompt.analysis.cellTopic': 'the point of difference, one line',
  'prompt.analysis.cellPosition': "that AI's position (- if not mentioned)",
  'prompt.analysis.cellVerdict': 'which side is right and why, one line',
  'prompt.analysis.noDisagree': '(if there are no disagreements, write one line "- None" instead of the table)',
  'prompt.analysis.rest': [
    '## Weak evidence',
    '- [AI name] a claim made without evidence, or one that needs fact-checking (if none, write "- None")',
    '',
    '## Final answer',
    'The most accurate and complete final answer, reflecting the analysis above',
  ].join('\n'),

  // ---------- skills (prompt-lib.js) ----------
  'prompt.skill.compress': [
    'Below are instructions for an AI ("{name}"). Compress them to at most {n} characters.',
    '- Do not drop any rule, procedure, condition, prohibition or output format that must be followed.',
    '- Leave out explanations, background, examples, greetings and repetition; write a list of short imperative sentences.',
    '- An AI following the instructions will read this. Write in the same language as the original.',
    '- Put the result in a single code block and write nothing else.',
  ].join('\n'),
  'prompt.skill.compressOpen': '----- Original instructions -----',
  'prompt.skill.compressClose': '----- End -----',
  'prompt.skill.question': '### Question',
  'prompt.skill.one': ['### Instructions (skill: {name})', 'Follow the instructions below until this conversation ends. Do not explain or summarize the instructions themselves.'].join('\n'),
  'prompt.skill.many': [
    '### Instructions ({n} skills — earlier ones take priority)',
    'Follow all of the instructions below until this conversation ends. If they conflict, follow the one that comes first. Do not explain or summarize the instructions themselves.',
  ].join('\n'),
  'prompt.skill.change': '### Instruction change',
  'prompt.skill.drop': 'From now on, stop following these instructions: {names}',
  'prompt.skill.addOne': 'From now on, also follow the instructions below (if they conflict with earlier ones, follow these).',
  'prompt.skill.addMany': 'From now on, also follow the instructions below (if they conflict with earlier ones, follow these).',
  'prompt.skill.gone': 'previous skill',

  // ---------- web page questions and side panel (web-ask.js, side-panel.js) ----------
  'prompt.web.page': 'Web page',
  'prompt.web.selection': 'The following text was selected from the web page {src}.',
  'prompt.web.firstChars': ' (long, so only the first {n} characters)',
  'prompt.web.question': 'Question: ',
  'prompt.web.source': 'Source: {url}',
  'prompt.web.fetched': 'Fetched: {when}',
  'prompt.web.attached': 'The attached page.md is the body of the web page {src}.',
  'prompt.web.inline': 'The following is the body of the web page {src} that I am looking at now. Please answer based on it.',

  // ---------- workflow and fact check (v0.33.0) ----------
  "prompt.workflow.revise": "Below are an answer by {productName} and the feedback {feedbackName} gave on it.\n\n[Original question]\n{question}\n\n[{productName}'s answer]\n{product}\n\n[{feedbackName}'s feedback]\n{feedback}\n\nRewrite the answer as a complete text from start to finish, taking the feedback into account.\n- Fix what the feedback gets right; if a point is wrong, do not follow it and say why in one line.\n- Keep the parts that are already correct.",
  "prompt.workflow.verify": "Please verify whether the following answer is correct.\n\n[Original question]\n{question}\n\n[{name}'s answer]\n{answer}\n\nReply in exactly the format below. Do not rename or reorder the headings.\n\n## Verification\n- What you checked and the result (pass / problem) — one per line\n\n## Remaining problems\n- What still needs fixing (if none, write \"- None\")\n\n## Verdict\nPass or Needs changes (one word)",
  "prompt.fact.extract": "Below is {name}'s answer. Pick at most {max} claims from it whose truth can be checked.\n- Pick only things that can be checked by a web search, such as numbers, dates, names and cause-and-effect; leave out opinions, recommendations and general explanations.\n- One per line in the form \"1. claim\", each understandable on its own.\n- Write nothing else.\n\n[Original question]\n{question}\n\n[{name}'s answer]\n{answer}",
  "prompt.fact.check": "Please check with a web search whether each of the claims below is true.\n\n{claims}\n\nReply in exactly the table format below: one row per claim, with the same numbers as the list above.\n| # | Verdict | Evidence · source |\n|---|---|---|\n| 1 | Confirmed | one line of evidence and the source URL |\n\nUse only one of these verdicts: \"Confirmed\" (shown to be true), \"Refuted\" (not true), \"Partly\" (only partly true), \"No source\" (no reliable source found). Write nothing outside the table.",

  // ---------- commit message (commit-msg.js) ----------
  'prompt.commit.ask': [
    'I applied the changes you just proposed to the files below. Write a git commit message describing this change as a single English line (at most 72 characters, imperative mood, e.g. "Fix null check in user loader").',
    'Reply with the message line only — no explanation, quotes or code block.',
  ].join('\n'),

  // ---------- project mode (project-context.js) ----------
  // Answer rules: change proposals and the file collector only find changes written in this format. {n} = EDIT_LINES
  'prompt.proj.rules': [
    '[Answer rules]',
    '1) First explain the cause or the design in at most 3 lines.',
    '2) Do not give file changes as a diff. For each file, write a "File: path" line followed by one code block. Put only one file in a code block.',
    '   - A new file, or a file of {n} lines or fewer: the FULL content of that file. Do not shorten it with "..." or "(unchanged)"; write it from the first line to the last.',
    '   - An existing file longer than {n} lines: do not rewrite the whole file; give only the parts to change as search/replace (so the answer does not get cut off). The search part must be copied from the current file exactly (not one character changed), with a few surrounding lines so that it matches only one place in the file. If several places change, write several search/replace pairs in the one block.',
    '   If the content itself contains ``` (.md files and so on), use a longer outer fence ```` (4 backticks) so the block does not end early:',
    'File: path/short-file',
    '```',
    '(the full new content)',
    '```',
    'File: path/long-file',
    '```',
    '<<<<<<< SEARCH',
    '(the part of the current file to change, exactly)',
    '=======',
    '(the new content)',
    '>>>>>>> REPLACE',
    '```',
    '   If the code itself has a line that is only =======, include enough surrounding lines for the search part to match only one place in the file.',
    '3) If files must be deleted, list them on one line: DELETE_FILES: path1, path2',
    '4) If you need to see more files, list them on one line at the very end of your answer: NEED_FILES: path1, path2',
  ].join('\n'),
  'prompt.proj.fileLabel': '[File: {path}]',
  'prompt.proj.treeCut': '… ({n} more lines omitted)',
  'prompt.proj.head': '[Project: {name}] (content of {n} of the {total} files that passed the exclusion rules)',
  'prompt.proj.tree': '[Project structure]',
  'prompt.proj.request': '[Request]',
  'prompt.proj.noRequest': '(no request — please review the content above)',
  'prompt.proj.noRequestAttached': '(no request — please review the attached content)',
  'prompt.proj.noRequestPlain': '(no request)',
  'prompt.proj.short': '[Project: {name}] The attached {file} has the project structure and the content of {n} file(s).',
  'prompt.proj.cut': '… (too long — the content stops here)',
  'prompt.proj.followUp': 'Here are the files you asked for.',
  'prompt.proj.skipped': '[Files not sent]',
  'prompt.proj.sameRules': 'Continue your answer following the same answer rules.',
  'prompt.proj.refetchIntro': 'The diff you gave for the file below did not match its current content, so it could not be applied. Here is the current content.',
  'prompt.proj.refetchFull': 'Give the FULL new content of the file again, as one code block after a "File: {path}" line.',
  'prompt.proj.planFirst': [
    '[Large task — plan only in this answer]',
    'Do not write code in this answer. There are many files to change, so I will take the plan first and then ask for each file separately.',
    '1) Explain what you will change and how, in at most 5 lines.',
    '2) List the files to change or create, in the order you will edit them, one per line as "- path: what to do in that file, one line".',
    '3) At the very end, list the same files on one line: PLAN_FILES: path1, path2, path3',
    '4) List files to delete as DELETE_FILES: path. List files you need to see as NEED_FILES: path.',
    'Follow the answer rules below (the code format) when I ask for each file.',
  ].join('\n'),
  'prompt.proj.step': [
    'Following the plan, give only file {i}/{total}: {path}{note}',
    'Write it as one code block after a "File: {path}" line, following the original answer rules ({n} lines or fewer, or a new file: full content; a longer existing file: search/replace).',
    'Write only this file in this answer and no other file. Keep the explanation to 2 lines. I will ask for the next file separately.',
  ].join('\n'),
  'prompt.proj.skip.binary': 'binary file',
  'prompt.proj.skip.tooLarge': 'larger than 1MB',
  'prompt.proj.skip.missing': 'the file does not exist',
  'prompt.proj.skip.unreadable': 'could not be read',
  'prompt.proj.skip.secret': 'not sent because it contains what looks like a secret',
  'prompt.proj.skip.badPath': 'path not allowed',
  'prompt.proj.skip.notInProject': 'not a file in the project',
  'prompt.proj.skip.excluded': 'exclusion rule: {rule}',

  // ---------- project file upload (project-upload.js) ----------
  'prompt.up.part': '({path} — a large file split into {total} parts: {i}/{total}; joined together they are one file)',
  'prompt.up.chunk': '(part {i} of {total})',
  'prompt.up.filesRule':
    'In the uploaded file names, "__" stands for a folder separator and the trailing ".txt" was added for the upload. In your answer, use the real paths (the right side of the list) in "File: path", NEED_FILES and DELETE_FILES.',
  'prompt.up.mapHead': '[{n} uploaded file(s) → real path]',
  'prompt.up.mapHeadPlain': '[Uploaded files → real path]',
  'prompt.up.noFiles': '(no file content uploaded)',
  'prompt.up.treeAttached': '[Project structure] It is in the attached project-structure.md.',
  'prompt.up.attachedHas': 'The attached {names} has the project structure and the content of {n} file(s).',
  'prompt.up.followFiles': 'I uploaded the {n} file(s) you asked for.',
  'prompt.up.followBundle': 'The content of the {n} file(s) you asked for is in the attached {names}.',
  'prompt.up.editedIntro': 'I edited project files locally. Use the content below instead of what I sent before.',
  'prompt.up.editedAck': 'Do not change anything now; just confirm what changed in at most 3 lines. Keep following the same answer rules from the next request.',
  'prompt.up.editedBundle': 'The current content of the {n} changed file(s) is in the attached {names}.',
  'prompt.up.gone': '[Deleted files]',
  'prompt.up.refetch.diffFile': 'The change you proposed for the attached file {name} ({path}) did not match its current content, so it could not be applied. The attachment is the current content.',
  'prompt.up.refetch.truncFile': 'Your answer for the attached file {name} ({path}) was long and got cut off, so it could not be applied. The attachment is the current content.',
  'prompt.up.refetch.diffBundle': 'The change you proposed for the file in the attached {name} ({path}) did not match its current content, so it could not be applied. The attachment is the current content.',
  'prompt.up.refetch.truncBundle': 'Your answer for the file in the attached {name} ({path}) was long and got cut off, so it could not be applied. The attachment is the current content.',
  'prompt.up.refetch.long':
    'This file is long, so do not rewrite all of it. After a "File: {path}" line, give one code block with only the parts to change as search/replace (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE). The search part must be the current content exactly and match only one place in the file.',
  'prompt.up.inc.head': '[Project: {name}] (follow-up question — only the {n} changed or newly sent file(s) uploaded{same})',
  'prompt.up.inc.headSame': ' · {n} unchanged since last sent',
  'prompt.up.inc.fileHead': '[Project: {name}] (structure of the {total} files that passed the exclusion rules · content of {n} file(s))',
  'prompt.up.inc.same': '[Unchanged since last sent] (not uploaded again because the content did not change — keep using what you received before)',
  'prompt.up.inc.lines': ' ({n} lines)',
  'prompt.up.inc.gone': '[Deleted files] (sent before, but they no longer exist)',
  'prompt.up.inc.treeFiles': 'The attached {names} has the project structure and the current content of {n} file(s).',
  'prompt.up.inc.treeChanged': 'The attached {names} has the project structure and the current content of {n} changed file(s).',
  'prompt.up.inc.treeOnly': 'The attached {names} has the project structure.',
  'prompt.up.inc.files': 'The attached {names} has the current content of {n} file(s).',
  'prompt.up.inc.changed': 'The attached {names} has the current content of {n} changed file(s).',

  // ---------- continue a cut-off answer (patch.js) ----------
  'prompt.cont.label': 'File: {path} (continued)',
  'prompt.cont.after': 'If you were going to give other files after this one, give them after finishing this file, following the original answer rules ("File: path" + code block).',
  'prompt.cont.edit': [
    'The search/replace for "File: {path}" in your last answer was cut off by the output limit. I received {done} complete search/replace pair(s).',
    'Give only the remaining pairs, starting from number {next}, in the same format as before (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE), in one code block after a "{label}" line.',
    'Do not repeat the pairs I already received and write no other explanation. If you cannot finish this time either, stop after the last complete block.',
  ].join('\n'),
  'prompt.cont.restart': 'The code for "File: {path}" in your last answer was cut off by the output limit. Give the full content of that file again from the beginning, as one code block after a "{label}" line.',
  'prompt.cont.fullHead': 'The code for "File: {path}" in your last answer was cut off by the output limit. I received it up to this line:',
  'prompt.cont.fullTail': [
    'Write this line once more, exactly, as the first line, then give only the rest of the file from the next line to the end, as one code block after a "{label}" line.',
    'Do not repeat the earlier part and write no other explanation. If you cannot finish this time either, stop at the end of a line.',
  ].join('\n'),
  // ---------- built-in templates (renderer/templates.js — {q} is replaced by the typed text) ----------
  'prompt.tpl.summary': "Summarize the following concisely, keeping only the key points.\n\n{q}",
  'prompt.tpl.explain': "Explain the following simply enough for a beginner to understand. Use analogies or examples.\n\n{q}",
  'prompt.tpl.step': "{q}\n\nThink it through step by step before you answer.",
  'prompt.tpl.proscons': "{q}\n\nCompare the pros and cons in a table and give a final recommendation.",
  'prompt.tpl.factcheck': "Check whether the following is true. If anything is wrong, point it out with evidence.\n\n{q}",
  'prompt.tpl.to-en': "Translate the following into natural English.\n\n{q}",
  'prompt.tpl.to-ko': "Translate the following into natural Korean.\n\n{q}",
  'prompt.tpl.code-review': "Review the following code. Point out problems in the order bugs, security, performance, readability. Show the corrected code not as a diff: for each file write one \"File: path\" line and, below it, one code block with the full corrected content. For a file longer than 150 lines, give only the parts to change instead, inside the same code block, as \"<<<<<<< SEARCH / (the current code, exactly) / ======= / (the new code) / >>>>>>> REPLACE\". If the content itself contains ``` (.md files and so on), use ```` (4 backticks) for the outer fence.\n\n{q}",
  'prompt.tpl.file-collect': "Change the code or create the files needed for the request below.\n\nAnswer format (please follow it exactly):\n1. Start with the list of files that change, marked [new file] / [modified] / [deleted].\n2. For each changed or new file, write one \"File: path\" line and, right below it, one code block with the full content of that file. Do not give a diff.\n3. Never omit code. No lines like \"... same as before\": each file must be complete and ready to paste as is.\n4. Give each file as a single code block however long it is. Do not split it into several blocks; write explanations outside the code blocks.\n5. For files whose content contains ``` (.md, .txt and so on), wrap them in a longer outer fence ```` (4 backticks) so the block does not end early.\n6. List files to delete at the end on one line: \"DELETE_FILES: path1, path2\".\n7. If you do not know a path, choose one that fits the project naturally.\n\nRequest:\n{q}",
});
