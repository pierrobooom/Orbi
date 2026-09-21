// European Portuguese (pt-PT) strings.
//
// Keys are the English source text, so a missing entry falls back to
// readable English rather than a raw key like "settings.title". That
// also means adding a new English string never breaks this build — it
// just shows in English until someone adds a line here.
//
// Portugal vocabulary throughout, never Brazilian: "telemóvel" not
// "celular", "ecrã" not "tela", "utilizador" not "usuário",
// "a carregar" not "carregando".

export const ptPT: Record<string, string> = {
  // --- auth -------------------------------------------------------------
  "Welcome back": "Bem-vindo de volta",
  "Sign in to your Orbi universe": "Entra no teu universo Orbi",
  "Email": "Email",
  "Password": "Palavra-passe",
  "Sign in": "Entrar",
  "New to Orbi?": "Novo no Orbi?",
  "Create an account": "Criar uma conta",
  "you@example.com": "tu@exemplo.com",
  "Create your universe": "Cria o teu universo",
  "Full name": "Nome completo",
  "Jane Doe": "Maria Silva",
  "At least 6 characters": "Pelo menos 6 caracteres",
  "Create account": "Criar conta",
  "Already have an account?": "Já tens conta?",
  "Free plan, no card required": "Plano gratuito, sem cartão",

  // --- tabs / universe --------------------------------------------------
  "Tasks": "Tarefas",
  "Universe": "Universo",
  "Money": "Dinheiro",
  "Task": "Tarefa",
  "Cluster": "Grupo",
  "Listening…": "A ouvir…",
  "Parsing…": "A interpretar…",
  "Retry": "Tentar de novo",
  "Could not load tasks": "Não foi possível carregar as tarefas",
  "No tasks here yet": "Ainda não há tarefas aqui",
  "Re-center": "Centrar",
  "Your universe is empty": "O teu universo está vazio",
  "No active tasks": "Sem tarefas activas",
  "Hold the mic or tap + on the Universe to add one.":
    "Mantém o micro premido ou toca em + no Universo para adicionar uma.",

  // --- tasks tab --------------------------------------------------------
  "Filter tasks": "Filtrar tarefas",
  "Priority": "Prioridade",
  "Due date": "Data limite",
  "No matches": "Sem resultados",
  "related": "relacionada",
  "{n} active": "{n} activas",
  "{n} of {total}": "{n} de {total}",

  // --- search -----------------------------------------------------------
  "Search": "Pesquisar",
  "What are you looking for?": "O que procuras?",
  "Close": "Fechar",

  // --- new task ---------------------------------------------------------
  "New task": "Nova tarefa",
  "What needs doing?": "O que precisas de fazer?",
  "Bubble label": "Etiqueta da bolha",
  "Auto-filled from title": "Preenchida a partir do título",
  "No cluster": "Sem grupo",
  "Due": "Prazo",
  "Clear": "Limpar",
  "Cancel": "Cancelar",
  "Done": "Concluído",
  "Add to universe": "Adicionar ao universo",

  // --- voice confirm ----------------------------------------------------
  "Confirm task": "Confirmar tarefa",
  "You said": "Disseste",
  "Parsed title": "Título interpretado",
  "Description": "Descrição",
  "Importance": "Importância",
  "Skip": "Ignorar",
  "Edit cluster": "Editar grupo",
  "Nothing matches \"{q}\".": "Nada corresponde a \"{q}\".",
  "Add & next": "Adicionar e seguinte",
  "Could not read voice payload": "Não foi possível ler a captura de voz",
  "Short keyword shown inside the bubble":
    "Palavra curta mostrada dentro da bolha",
  "Sub-items, notes, context — empty if none":
    "Sub-itens, notas, contexto — vazio se não houver",
  "What you'll see in the bubble. Edit it now or keep what we picked.":
    "O que vais ver na bolha. Edita agora ou mantém o que escolhemos.",
  "We auto-fill this when you mention details like item lists or specifics. Leave blank for simple tasks.":
    "Preenchemos isto quando mencionas detalhes como listas ou especificidades. Deixa em branco para tarefas simples.",
  "Parse confidence: {n}%": "Confiança da interpretação: {n}%",
  "Task {n} of {total}": "Tarefa {n} de {total}",

  // --- task detail ------------------------------------------------------
  "Title": "Título",
  "Pressure": "Pressão",
  "Edit": "Editar",
  "Save changes": "Guardar alterações",
  "Task not found": "Tarefa não encontrada",
  "Hold to mark complete": "Mantém premido para concluir",
  "Short keyword shown in the bubble": "Palavra curta mostrada na bolha",
  "Add notes — context, why it matters, who's involved…":
    "Adiciona notas — contexto, porque importa, quem está envolvido…",
  "Are you sure you want to delete this task?":
    "Tens a certeza que queres apagar esta tarefa?",
  "This will remove the task from your universe.":
    "Isto remove a tarefa do teu universo.",
  "Delete": "Apagar",
  "Yes, delete": "Sim, apagar",
  "OK": "OK",

  // --- move task --------------------------------------------------------
  "Move task": "Mover tarefa",
  "Move to": "Mover para",
  "Adrift (no cluster)": "À Deriva (sem grupo)",

  // --- clusters ---------------------------------------------------------
  "Name": "Nome",
  "Color": "Cor",
  "Preview": "Pré-visualização",
  "Save": "Guardar",
  "New cluster": "Novo grupo",
  "Delete cluster": "Apagar grupo",
  "Delete cluster?": "Apagar grupo?",
  "Tasks inside this cluster will move to Adrift.":
    "As tarefas deste grupo passam para À Deriva.",
  "Dimmed colors are already used by another cluster.":
    "As cores esbatidas já estão a ser usadas por outro grupo.",
  "Adrift": "À Deriva",
  "Adrift is the catch-all": "À Deriva é o grupo de recolha",
  "Work, Health, Reading…": "Trabalho, Saúde, Leitura…",
  "Organise clusters": "Organizar grupos",
  "Reviewing your universe…": "A analisar o teu universo…",
  "Your universe is already tidy.": "O teu universo já está arrumado.",
  "Try again once you've added a few more tasks.":
    "Tenta de novo depois de adicionares mais algumas tarefas.",
  "Universe updated": "Universo actualizado",
  "Couldn't apply": "Não foi possível aplicar",

  // --- money ------------------------------------------------------------
  "Spent this month": "Gasto este mês",
  "No expenses yet": "Ainda não há despesas",
  "Tap the + button to log your first one.":
    "Toca no botão + para registares a primeira.",
  "Could not load entries": "Não foi possível carregar os registos",
  "New expense": "Nova despesa",
  "Amount": "Valor",
  "Merchant": "Comerciante",
  "Date": "Data",
  "Log expense": "Registar despesa",
  "Tesco, Uber, Netflix…": "Continente, Uber, Netflix…",
  "Entry": "Registo",
  "Entry not found": "Registo não encontrado",
  "Category": "Categoria",
  "Notes": "Notas",
  "Optional context": "Contexto opcional",
  "Delete entry": "Apagar registo",
  "Changing the merchant re-runs categorisation.":
    "Mudar o comerciante volta a correr a categorização.",
  "Today": "Hoje",
  "Yesterday": "Ontem",

  // --- settings ---------------------------------------------------------
  "Settings": "Definições",
  "Profile": "Perfil",
  "Plan": "Plano",
  "See plans →": "Ver planos →",
  "Language": "Idioma",
  "Used for speech recognition and for the language Orbi replies in.":
    "Usado no reconhecimento de voz e no idioma em que o Orbi responde.",
  "Loading…": "A carregar…",
  "Notifications": "Notificações",
  "Push notifications": "Notificações push",
  "Enable in iOS Settings": "Activar nas Definições do iOS",
  "Disable in iOS Settings": "Desactivar nas Definições do iOS",
  "Status": "Estado",
  "API endpoint": "Endpoint da API",
  "Dev tools": "Ferramentas de programação",
  "Register push device": "Registar dispositivo push",
  "Send test push": "Enviar push de teste",
  "Device registered": "Dispositivo registado",
  "Registration failed": "Falha no registo",
  "Test push sent": "Push de teste enviado",
  "Test push failed": "Falha no push de teste",
  "Sign out": "Terminar sessão",
  "Sign out?": "Terminar sessão?",
  "You'll need to sign back in to use Orbi.":
    "Vais precisar de entrar de novo para usar o Orbi.",
  "Ask Orbi to suggest cluster merges, moves, and new groupings.":
    "Pede ao Orbi para sugerir fusões, movimentos e novos grupos.",
  "Removed before launch.": "Removido antes do lançamento.",
  "Notifications were declined earlier. Enable them in iOS Settings → Expo Go → Notifications.":
    "As notificações foram recusadas anteriormente. Activa-as em Definições do iOS → Expo Go → Notificações.",
  "iOS handles notification permissions itself. Disable them in Settings → Expo Go → Notifications.":
    "O iOS gere as permissões de notificação. Desactiva-as em Definições → Expo Go → Notificações.",

  // --- upgrade ----------------------------------------------------------
  "Your plan": "O teu plano",
  "Coming soon": "Em breve",
  "Orbi has three tiers. Pick the one that fits your universe.":
    "O Orbi tem três planos. Escolhe o que se ajusta ao teu universo.",
  "Payments land in Phase 5 via the App Store and Play Store. Sit tight.":
    "Os pagamentos chegam na Fase 5 via App Store e Play Store. Aguarda.",

  // --- long-form hints ---
  "Tap to deselect anything you don't want. Approved changes apply when you tap Apply.":
    "Toca para desmarcar o que não queres. As alterações aprovadas aplicam-se quando tocares em Aplicar.",
  "Orbi looks across every task you have, regardless of cluster. Hold the mic to dictate.":
    "O Orbi procura em todas as tuas tarefas, independentemente do grupo. Mantém o micro premido para ditar.",
  "Adrift collects tasks that haven't been assigned to a cluster yet. It can't be renamed, recolored, or deleted. Move tasks out of Adrift by editing each one, or use Organise clusters to let Orbi suggest a new home for them.":
    "À Deriva recolhe as tarefas que ainda não foram atribuídas a um grupo. Não pode ser renomeada, recolorida nem apagada. Move as tarefas para fora de À Deriva editando cada uma, ou usa Organizar grupos para o Orbi sugerir um novo destino.",
  "Known merchants categorize automatically. Unknowns stay uncategorized on Spark; Pro and Genius use AI to guess.":
    "Comerciantes conhecidos são categorizados automaticamente. Os desconhecidos ficam sem categoria no Spark; o Pro e o Genius usam IA para adivinhar.",
  "Short keyword shown inside the bubble. Auto-suggested from the title — feel free to type your own.":
    "Palavra curta mostrada dentro da bolha. Sugerida a partir do título — escreve a tua se preferires.",

  // --- voice confirm editing ---
  "No due date": "Sem prazo",
  "Hold to fix this by voice": "Mantém premido para corrigir por voz",
  "Could not start recording.": "Não foi possível iniciar a gravação.",
  "Couldn't hear that. Try again.": "Não percebi. Tenta de novo.",
  "Keep the mic pressed to record.": "Mantém o micro premido para gravar.",

  // --- task filters ---
  "Overdue": "Atrasadas",
  "Show done": "Ver concluídas",
  "{n} done": "{n} concluídas",
  "{n} overdue": "{n} atrasadas",
  "Nothing completed yet": "Ainda nada concluído",
  "Nothing overdue": "Nada atrasado",
  "Nothing is past its due date. Good.": "Nada passou do prazo. Boa.",
  "Tasks you complete show up here for {n} days.": "As tarefas que concluíres aparecem aqui durante {n} dias.",

  // --- voice actions on existing tasks ---
  "Confirm": "Confirmar",
  "Change": "Alteração",
  "Or did you mean": "Ou querias dizer",
  "Mark as done": "Marcar como concluída",
  "Apply change": "Aplicar alteração",
  "Nothing to change.": "Nada a alterar.",
  "Nothing matches that.": "Nada corresponde a isso.",
  "Couldn't find that task.": "Não encontrei essa tarefa.",
  "More than one task matches. Check this is the right one.": "Mais do que uma tarefa corresponde. Confirma se é a certa.",
  "Reopen task": "Reabrir tarefa",

  // --- chat tab ---
  "Chat": "Conversa",
  "New": "Nova",
  "Message Orbi": "Escreve ao Orbi",
  "Ask Orbi anything": "Pergunta o que quiseres ao Orbi",
  "Capture a task, ask what's overdue, or mark something done — typed or spoken.": "Cria uma tarefa, pergunta o que está atrasado, ou marca algo como feito — escrito ou falado.",
  "Not sent": "Não enviada",
  "Review task": "Rever tarefa",
  "Review {n} tasks": "Rever {n} tarefas",
  "Review change": "Rever alteração",
  "From chat": "Da conversa",

  // --- account deletion ---
  "Delete account": "Apagar conta",
  "This cannot be undone. Everything below is deleted immediately.": "Isto não pode ser revertido. Tudo o que está abaixo é apagado imediatamente.",
  "What gets deleted": "O que é apagado",
  "Your account and sign-in": "A tua conta e o acesso",
  "Every task and cluster": "Todas as tarefas e grupos",
  "All finance entries and budgets": "Todos os registos e orçamentos",
  "Conversations and memories": "Conversas e memórias",
  "Preferences and notification devices": "Preferências e dispositivos de notificação",
  "Type your email to confirm": "Escreve o teu email para confirmar",
  "Permanently delete my account": "Apagar a minha conta permanentemente",
  "Showing {n} of {total}": "A mostrar {n} de {total}",

  // --- accounts ---------------------------------------------------------
  "Accounts": "Contas",
  "All accounts": "Todas as contas",
  "Movements": "Movimentos",
  "Dashboard": "Resumo",
  "Nothing to show yet": "Ainda não há nada para mostrar",
  "Once this month has some transactions, you'll see where the money went and whether that's unusual for you.":
    "Assim que este mês tiver movimentos, vais ver para onde foi o dinheiro e se isso é invulgar para ti.",
  "Came in": "Entrou",
  "Left over": "Sobrou",
  "Where it went": "Para onde foi",
  "Most spent with": "Onde gastaste mais",
  "Day by day": "Dia a dia",
  "no history yet": "ainda sem histórico",
  "about usual": "como é habitual",
  "more than usual": "mais do que o habitual",
  "less than usual": "menos do que o habitual",
  "Usually {amount} by now": "Habitualmente {amount} a esta altura",
  "once": "uma vez",
  "{n} times": "{n} vezes",
  "1st": "dia 1",
  "Peak {amount}": "Máximo {amount}",
  "{n} transactions have no category. Tap one in Movements to sort it — the rest of this gets sharper as you do.":
    "{n} movimentos não têm categoria. Toca num em Movimentos para a definir — o resto fica mais preciso à medida que o fazes.",
  "Tap to categorise": "Toca para categorizar",
  "No accounts yet": "Ainda não há contas",
  "Add the accounts your money moves through. Each transaction can then be filed to one, so you can see what's actually in each.":
    "Adiciona as contas por onde o teu dinheiro passa. Cada movimento pode depois ser associado a uma, para veres o que tens em cada.",
  "Add an account": "Adicionar uma conta",
  "Total": "Total",
  "Across accounts included in the total.": "Nas contas incluídas no total.",
  "No account number": "Sem número de conta",
  "{n} transactions": "{n} movimentos",
  "Not counted in the total": "Não contabilizada no total",
  "Automatic import is on": "Importação automática activa",
  "Manual tracking": "Registo manual",
  "An account number labels an account and files imported transactions to it. It can't fetch anything on its own — banks only release transactions after you sign in with them directly and approve it.":
    "O número da conta serve para identificar a conta e associar-lhe movimentos importados. Não vai buscar nada sozinho — os bancos só libertam movimentos depois de entrares directamente com eles e autorizares.",
  "Update now": "Actualizar agora",
  "Recurring transactions": "Movimentos recorrentes",
  "Rent, subscriptions, the gym — entered once, created for you every time they're due.":
    "Renda, subscrições, ginásio — registas uma vez e são criados sempre que se repetem.",
  "Long-press an account to delete it.": "Mantém premida uma conta para a apagar.",
  "Delete account?": "Apagar conta?",
  "Transactions stay in your history — they just stop being assigned to this account.":
    "Os movimentos ficam no teu histórico — deixam apenas de estar associados a esta conta.",
  "Could not delete": "Não foi possível apagar",
  "Could not run": "Não foi possível executar",
  "Could not save": "Não foi possível guardar",
  "Finance updated": "Finanças actualizadas",
  "{n} recurring entries created": "{n} movimentos recorrentes criados",
  "{n} transactions imported": "{n} movimentos importados",
  "Already up to date — checked moments ago.": "Já está actualizado — verificado há momentos.",
  "No new transactions since the last check.": "Sem movimentos novos desde a última verificação.",
  "No bank provider is configured, so nothing was imported.":
    "Não há nenhum fornecedor bancário configurado, por isso não foi importado nada.",

  // --- connect bank (consent explainer) ---------------------------------
  "Automatic updates": "Actualizações automáticas",
  "Connect {name} so your spending appears on its own.":
    "Liga a conta {name} para os teus gastos aparecerem sozinhos.",
  "Connect your account so your spending appears on its own.":
    "Liga a tua conta para os teus gastos aparecerem sozinhos.",
  "You'll go to your bank": "Vais ao teu banco",
  "We open your bank's own website so you can sign in there. Orbi never sees your password or your security code.":
    "Abrimos o site do teu banco para entrares lá. O Orbi nunca vê a tua palavra-passe nem o teu código de segurança.",
  "You approve what we can see": "Autorizas o que podemos ver",
  "Your bank asks whether to share this account with Orbi. You decide, and your bank keeps the record.":
    "O teu banco pergunta se queres partilhar esta conta com o Orbi. Decides tu, e o registo fica com o banco.",
  "Then it updates itself": "Depois actualiza-se sozinho",
  "Once a day Orbi checks for new transactions and sorts them into categories. Nothing to press.":
    "Uma vez por dia o Orbi procura novos movimentos e organiza-os por categoria. Não tens de carregar em nada.",
  "What Orbi can and can't do": "O que o Orbi pode e não pode fazer",
  "Can see: your transactions and balance, so it can sort your spending.":
    "Pode ver: os teus movimentos e saldo, para organizar os teus gastos.",
  "Cannot move money. Access is read-only — no payments, no transfers.":
    "Não pode mover dinheiro. O acesso é só de leitura — sem pagamentos, sem transferências.",
  "Never sees your login. You type it on your bank's site, not here.":
    "Nunca vê os teus dados de acesso. Escreve-los no site do banco, não aqui.",
  "Expires after about 90 days. Your bank asks you to approve again — we'll remind you a week before.":
    "Expira ao fim de cerca de 90 dias. O banco pede-te para autorizares de novo — avisamos-te uma semana antes.",
  "Stop any time. Disconnect here or at your bank. Transactions already saved stay yours.":
    "Podes parar quando quiseres. Desliga aqui ou no teu banco. Os movimentos já guardados continuam a ser teus.",
  "Orbi reaches your bank through a licensed open-banking provider — the same rules every banking app follows. Your finance data is never shared with anyone.":
    "O Orbi chega ao teu banco através de um fornecedor de open banking licenciado — as mesmas regras que qualquer aplicação bancária segue. Os teus dados financeiros nunca são partilhados com ninguém.",
  "Continue to my bank": "Continuar para o meu banco",
  "Not now": "Agora não",
  "Prefer not to connect? You can import a statement from your bank instead — it works the same way, just manually.":
    "Preferes não ligar? Podes importar um extracto do teu banco — funciona da mesma forma, só que manualmente.",

  "Import a statement": "Importar um extracto",
  "Statement imported": "Extracto importado",
  "Could not import": "Não foi possível importar",
  "Could not read the file": "Não foi possível ler o ficheiro",
  "{n} transactions added": "{n} movimentos adicionados",
  "{n} were already there": "{n} já lá estavam",
  "{n} still pending, skipped": "{n} ainda pendentes, ignorados",
  "Connect for automatic import": "Ligar para importação automática",
  "Connected · syncs daily": "Ligada · sincroniza diariamente",
  "Connected · first sync pending": "Ligada · primeira sincronização pendente",
  "Not approved yet": "Ainda não aprovada",
  "Finish": "Concluir",
  "Waiting for your bank's approval": "À espera da aprovação do teu banco",
  "Connected": "Ligada",
  "Could not connect": "Não foi possível ligar",
  "Could not disconnect": "Não foi possível desligar",
  "Disconnect": "Desligar",
  "Disconnect?": "Desligar?",
  "Transactions already imported stay. This only stops new ones arriving.":
    "Os movimentos já importados ficam. Isto só impede a chegada de novos.",
  "Approve with your bank": "Aprovar com o teu banco",
  "Continue": "Continuar",

  // --- account editor ---------------------------------------------------
  "New account": "Nova conta",
  "Edit account": "Editar conta",
  "Account not found": "Conta não encontrada",
  "Revolut, Caixa, Savings…": "Revolut, Caixa, Poupança…",
  "Account number (optional)": "Número da conta (opcional)",
  "That doesn't look like a valid IBAN — check for a missing digit.":
    "Isto não parece um IBAN válido — verifica se falta algum dígito.",
  "Used to label this account and to file imported transactions to it. It doesn't connect to your bank on its own — no app can read an account from its number alone.":
    "Serve para identificar esta conta e associar-lhe movimentos importados. Não liga ao teu banco sozinho — nenhuma aplicação consegue ler uma conta apenas pelo número.",
  "Currency": "Moeda",
  "Can't be changed later — it would reinterpret every amount already recorded.":
    "Não pode ser alterada depois — mudaria o significado de todos os valores já registados.",
  "Starting balance": "Saldo inicial",
  "What was in the account when you started tracking. Every transaction you record moves the balance from here.":
    "O que tinhas na conta quando começaste a registar. Cada movimento que registas move o saldo a partir daqui.",
  "Primary account": "Conta principal",
  "The default for new transactions, including ones from a receipt photo.":
    "A predefinida para novos movimentos, incluindo os criados a partir de uma foto de recibo.",
  "Include in total": "Incluir no total",
  "Turn off for an account you track but don't count as yours to spend.":
    "Desliga para uma conta que acompanhas mas não contas como tua para gastar.",
  "Visible": "Visível",
  "Hidden accounts stay in your data but drop out of the list.":
    "As contas ocultas ficam nos teus dados mas saem da lista.",

  // --- recurring --------------------------------------------------------
  "Recurring": "Recorrentes",
  "Spending limits": "Limites de gastos",
  "A ceiling per category. Orbi tells you as you approach one — once, not every hour.":
    "Um tecto por categoria. O Orbi avisa-te quando te aproximares — uma vez, não de hora a hora.",
  "Monthly limit": "Limite mensal",
  "Set limit": "Definir limite",
  "No limits set": "Sem limites definidos",
  "Put a ceiling on a category and Orbi will tell you as you approach it — once, not every hour.":
    "Define um tecto para uma categoria e o Orbi avisa-te quando te aproximares — uma vez, não de hora a hora.",
  "Set the first one": "Definir o primeiro",
  "You'll be told once when you reach 80%, and once if you go over. Never more than that.":
    "Serás avisado uma vez ao chegar aos 80% e uma vez se ultrapassares. Nunca mais do que isso.",
  "{amount} left": "faltam {amount}",
  "{amount} over": "{amount} acima",
  "Alerts": "Avisos",
  "Remove this limit?": "Remover este limite?",
  "Your transactions stay exactly as they are — only the ceiling and its alerts go.":
    "Os teus movimentos ficam exactamente como estão — só o tecto e os avisos desaparecem.",
  "Remove": "Remover",
  "Could not remove": "Não foi possível remover",
  "Long-press a limit to remove it.": "Mantém premido um limite para o remover.",
  "Limits": "Limites",
  "Netflix, rent, gym…": "Netflix, renda, ginásio…",
  "How often": "Com que frequência",
  "Weekly": "Semanal",
  "Monthly": "Mensal",
  "Yearly": "Anual",
  "Account": "Conta",
  "Add rule": "Adicionar regra",
  "Starts today. The first entry appears the next time Orbi updates your finances.":
    "Começa hoje. O primeiro movimento aparece da próxima vez que o Orbi actualizar as tuas finanças.",
  "Nothing recurring yet": "Ainda não há recorrentes",
  "Most of a month is the same handful of things. Add them once and they'll record themselves.":
    "A maior parte de um mês são sempre as mesmas coisas. Adiciona-as uma vez e passam a registar-se sozinhas.",
  "Add the first one": "Adicionar a primeira",
  "Every {every}{unit}": "A cada {every}{unit}",
  "week": "semana",
  "weeks": "semanas",
  "month": "mês",
  "months": "meses",
  "year": "ano",
  "years": "anos",
  "Next: {date}": "Próximo: {date}",
  "Paused": "Em pausa",
  "Long-press a rule to delete it.": "Mantém premida uma regra para a apagar.",
  "Delete this rule?": "Apagar esta regra?",
  "Entries it already created stay — they're money that actually moved.":
    "Os movimentos que já criou ficam — é dinheiro que realmente se moveu.",
  "Subscriptions": "Subscrições",
  "Groceries": "Supermercado",
  "Transport": "Transportes",
  "Health": "Saúde",
  "Finance": "Finanças",
  "Dining": "Restauração",
  "Shopping": "Compras",
  "Home": "Casa",
  "Other": "Outro",

  // --- reminders --------------------------------------------------------
  "Reminders": "Lembretes",
  "Remind me about tasks": "Lembrar-me das tarefas",
  "Orbi schedules nudges around each task's deadline.":
    "O Orbi agenda avisos à volta do prazo de cada tarefa.",
  "Before the deadline": "Antes do prazo",
  "A heads-up so it doesn't sneak up on you. Important tasks get more warning.":
    "Um aviso para não te apanhar desprevenido. As tarefas importantes avisam com mais antecedência.",
  "After the deadline": "Depois do prazo",
  "Asks whether you got it done, so it can be ticked off or postponed.":
    "Pergunta se conseguiste fazer, para poderes marcar como feita ou adiar.",
  "How much": "Quantidade",
  "{label} — at most {n} notifications a day. Anything over the limit is dropped, least urgent first.":
    "{label} — no máximo {n} notificações por dia. O que passar do limite é descartado, a começar pelas menos urgentes.",
  "Minimal": "Mínimo",
  "Light": "Leve",
  "Balanced": "Equilibrado",
  "Attentive": "Atento",
  "Insistent": "Insistente",
  "Quiet from": "Silêncio a partir das",
  "Quiet until": "Silêncio até às",
  "Nothing arrives during these hours. A reminder that falls inside waits for the morning rather than being lost.":
    "Nada chega durante estas horas. Um lembrete que caia neste período espera pela manhã em vez de se perder.",
  // Notification action buttons. Kept to one or two words — iOS truncates
  // them hard on the lock screen.
  "Snooze 1h": "Adiar 1h",
  "Reply": "Responder",
  "Send": "Enviar",
  "Tomorrow": "Amanhã",
  "Pick a time": "Escolher hora",
  "What happened?": "O que aconteceu?",
  "Mute reminders": "Silenciar lembretes",
  "No notifications for tasks in this cluster. The tasks stay exactly as they are — only the nudges stop.":
    "Sem notificações para as tarefas deste grupo. As tarefas ficam exactamente como estão — só os avisos param.",

  // Money hub — the tab is a menu of blocks now, not a ledger.
  "Across accounts": "Nas contas",
  "Spent in {month}": "Gasto em {month}",
  "vs usual": "vs habitual",
  "Insights": "Análises",
  "Vendors": "Comerciantes",
  "Categories": "Categorias",
  "Memberships": "Subscrições",
  "All movements": "Todos os movimentos",
  "Balances and movements": "Saldos e movimentos",
  "What's worth noticing": "O que vale a pena notar",
  "Where the money went": "Para onde foi o dinheiro",
  "Spend by shop and category": "Gastos por loja e categoria",
  "Subscriptions and repeats": "Subscrições e pagamentos repetidos",
  "Ceilings per category": "Tectos por categoria",
  "Every transaction this month": "Todos os movimentos deste mês",
  "Log an expense": "Registar uma despesa",
  // Movements
  "Spent this month · {account}": "Gasto este mês · {account}",
  "Nothing here yet": "Ainda não há nada aqui",
  "No movements on this account this month.":
    "Sem movimentos nesta conta este mês.",
  // Insights
  "Nothing unusual this month": "Nada de invulgar este mês",
  "A few more transactions and there will be something to compare against.":
    "Mais alguns movimentos e haverá com que comparar.",
  "Your spending looks like it usually does. This fills up when something stands out.":
    "Os teus gastos estão como de costume. Isto enche-se quando algo se destaca.",
  "Written insights are on Pro": "As análises escritas são do Pro",
  "The observations above are computed from your totals. Pro adds written analysis of patterns across the month.":
    "As observações acima são calculadas a partir dos teus totais. O Pro acrescenta análise escrita dos padrões do mês.",
  // Breakdown
  "Nothing spent this month": "Nada gasto este mês",
  "Movements you log or import will be broken down here.":
    "Os movimentos que registares ou importares são detalhados aqui.",
  // Account dropdown on the movements ledger.
  "Showing": "A mostrar",
  "Show movements from": "Mostrar movimentos de",
  // Bank connection health — consent expiry and reconnection.
  "A bank connection needs attention": "Uma ligação bancária precisa de atenção",
  "{n} bank connections need attention": "{n} ligações bancárias precisam de atenção",
  "Totals may be missing recent transactions. Tap to reconnect.":
    "Os totais podem não ter movimentos recentes. Toca para religar.",
  "Bank permission ends today": "A autorização do banco termina hoje",
  "Bank permission ends in {n} days": "A autorização do banco termina daqui a {n} dias",
  "Renew": "Renovar",
  "Reconnect": "Religar",
  "Stopped updating": "Deixou de actualizar",
  "Stopped updating on {date}": "Deixou de actualizar a {date}",
  "Sync problem": "Problema de sincronização",
  "We'll keep retrying. Reconnect if it persists.":
    "Vamos continuar a tentar. Religa se persistir.",
  "Your bank's permission expired. New transactions aren't arriving until you reconnect.":
    "A autorização do teu banco expirou. Não chegam novos movimentos até religares.",
  // Bank picker.
  "Choose your bank": "Escolhe o teu banco",
  "Search banks": "Procurar bancos",
  "Could not load the banks": "Não foi possível carregar os bancos",
  "Try again": "Tentar de novo",
  "No bank matches that": "Nenhum banco corresponde",
  "Check the spelling, or try another country.":
    "Verifica a escrita, ou tenta outro país.",
  "No banks available here": "Sem bancos disponíveis aqui",
  "Your bank may not be reachable yet. You can import a statement instead.":
    "O teu banco pode ainda não estar disponível. Podes importar um extracto.",
  "Your bank": "O teu banco",
  "Change bank": "Mudar de banco",
  "Continue to {bank}": "Continuar para {bank}",
  // Picking which approved account a connection refers to.
  "Which account is this?": "Que conta é esta?",
  "Your bank approved access to more than one account.":
    "O teu banco aprovou o acesso a mais do que uma conta.",
  "No accounts came back. Try connecting again.":
    "Não veio nenhuma conta. Tenta ligar outra vez.",
  "Could not finish connecting": "Não foi possível concluir a ligação",
  // Categories the user owns.
  "Make them fit your life": "Ajusta-as à tua vida",
  "Pets, gym, travel…": "Animais, ginásio, viagens…",
  "Add": "Adicionar",
  "Hidden": "Escondida",
  "Yours": "Tua",
  "Could not add it": "Não foi possível adicionar",
  "Delete {label}?": "Apagar {label}?",
  "Only works if nothing is filed under it.":
    "Só funciona se não houver nada nesta categoria.",
  "Sort what's left": "Organizar o resto",
  "Sorted": "Organizado",
  "Could not sort": "Não foi possível organizar",
  "Nothing else could be placed automatically.":
    "Não foi possível colocar mais nada automaticamente.",
  "{n} transactions sorted. {left} still unsorted.":
    "{n} movimentos organizados. {left} ainda por organizar.",
  "Tap to rename. Long-press one of your own to delete it. Changing a transaction's category teaches Orbi that shop for next time.":
    "Toca para mudar o nome. Mantém premida uma das tuas para apagar. Mudar a categoria de um movimento ensina o Orbi essa loja para a próxima.",
  "File {merchant} under": "Arquivar {merchant} em",
  "Manage categories": "Gerir categorias",
};
