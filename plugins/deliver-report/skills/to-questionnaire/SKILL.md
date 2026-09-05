---
name: to-questionnaire
description: >
  把「自己答不了的決策」變成給第三方填的問卷文件（Markdown，非同步填答或會議逐題過）。
  當使用者說「to-questionnaire」「做個問卷問客戶」「這要問代管商/窗口」「整理成問題清單給對方填」
  「這些開放問題要丟給誰確認」時觸發（僅使用者點名觸發，模型不得自主啟動）。
  引進自 mattpocock/skills（2026-08-07，正文保留原文英文，實戰後再決定是否中文化）。
  本 skill 產出的是**給對方填的問卷檔案**；問卷寫好後要配一封寄送信，走同 plugin 的 deliver-report。
disable-model-invocation: true
---

Turn something the user can't answer alone into a **questionnaire** — a Markdown document they hand to one person to fill in async, or fill out together over a meeting. The recipient holds knowledge the user lacks; the questionnaire pulls it out of them.

**Grill the send, not the subject.** Interview the user only about the _send_, which they can always answer: who it goes to, and what they need back. The questions in the document then target the **gap** between what the recipient knows and what the user needs.

1. **Who is it going to?** Ask, in one exchange, the recipient's role, expertise, and relationship to the user. This fixes the questionnaire's tone and how much context it must carry. Done when you know who the recipient is and what they know that the user doesn't.

2. **What do you need back?** Ask, in one exchange, the specific decisions or facts the user can't resolve alone and needs from this person. Done when you have a concrete list of what the user must walk away able to do or decide.

3. **Write the questionnaire.** Draft questions aimed at the gap from steps 1–2, following the Document structure below. Write it to `to-questionnaire-<slug>.md` in the current directory (slug from the topic) and report the path. Done when the file exists and every item the user named in step 2 is covered by a question.

> **本 plugin 補充**：對外送出的問卷屬交付物——語氣與術語密度照同 plugin `deliver-report` 的鐵則②③（預設讀者不懂技術、嚴禁內部流程字眼）；易讀性照 `../../references/document-readability.md` 十二條鐵則，交付前跑五項機械掃描。問卷寫好後若要配一封寄送信，走 `deliver-report`。

## Document structure

Frame the document as a **discovery questionnaire**: the user lacks context, the recipient holds it. Order questions most-important-first — async means you may only get one pass — and group them under `##` headings by theme once there are more than a handful. Write it using the template below.

<questionnaire-template>

# <Questionnaire title>

**Purpose:** why this questionnaire exists and the decision riding on it.

**From:** <the user> — **To:** <the recipient> — **How your answers will be used:** <where they go>

## Context

One paragraph orienting a recipient who wasn't in the user's head. Enough to answer well, not a page.

## How to answer

Deadline and rough effort. Partial answers and "I don't know" are useful — flag anything you're unsure of rather than skipping it.

## <Theme heading>

One `##` section per theme. Under each, its questions, most-important-first. Every question is one idea — never compound — with an answer stub directly beneath, and a one-line _why this matters_ only where the question could be misread or invite a throwaway answer.

<question-example>
### What load is the system expected to handle at launch?

_Why this matters: it decides whether we provision for burst traffic now or defer it._

>
</question-example>

## Anything else?

A closing catch-all: anything we didn't ask that we should know?

</questionnaire-template>

## Changelog
- 2026-08-07 引進自 mattpocock/skills productivity/to-questionnaire（經使用者核准；frontmatter 中文化＋補 deliver-report 銜接註記，正文原样保留）
