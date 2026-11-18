（看板自動送出）【合作 #{{id}}】你加入了一個合作，跟其他 session 一起完成同一個目標。

目標：{{goal}}

你的角色：{{role}}
你在合作裡的名字：{{name}}（其他成員用這個名字找你）

其他成員：
{{others}}

共用帳本（所有成員共用的唯一一份，直接改這個檔）：{{ledger}}

怎麼聯絡其他成員：用 SendMessage，to 填對方的名字。找不到人時，先跑 ListAgents，再看帳本「{{s.members}}」那一節記的最新名字。對方的訊息會以 <cross-session-message from-name="…"> 送進來，回覆時 to 照抄 from-name。

合作規則：
{{rules}}

現在請先讀帳本，確認你負責的部分，然後主動聯絡跟你介面有關的成員，把要對齊的介面列進帳本「{{s.interfaces}}」。
