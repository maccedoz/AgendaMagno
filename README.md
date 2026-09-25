# AgendaMagna

Agenda pessoal com painel e conversa no navegador, acessível pelo notebook e pelo celular. A conversa é processada durante a própria requisição, sem serviços de automação ou processos permanentes. Interface em português, fuso `America/Bahia` e acesso de um único proprietário, com senha, duas etapas opcionais e dispositivos confiáveis.

Os provedores de IA, modelos, chaves, prioridades e limites são cadastrados no próprio painel. A aplicação troca de provedor quando o anterior atinge um limite ou fica indisponível. A IA interpreta todas as mensagens da conversa e, se você quiser, reescreve a resposta em linguagem natural numa segunda chamada. Enquanto nenhum provedor estiver cadastrado e ativo, um modo reserva entende apenas algumas frases em formato exato.

## O que dá para fazer

Uma explicação sem termos técnicos de tudo o que o aplicativo faz hoje.

**Suas tarefas**

- Anotar o que precisa fazer, com um texto de apoio (contexto, links, lembretes escritos), prioridade, data, horário e etiquetas.
- Separar por grupos, com cor e ícone, e reordenar do jeito que fizer sentido. Grupos que saíram de cena podem ser arquivados sem perder nada.
- Quebrar uma tarefa em uma lista de etapas e ir marcando conforme avança.
- Repetir tarefas que voltam sempre: todo dia, toda semana nos dias escolhidos, ou todo mês. Ao concluir uma, a próxima já nasce na data certa.
- Marcar como feita no círculo ao lado do nome. A tarefa vai para a lista de concluídas, e não para o lixo.
- Descartar o que não serve mais. Fica na lixeira pelo prazo que você escolher (30 dias, de início) e dá para restaurar.
- Ver o que vence hoje, o que está atrasado e o que ficou sem data. Buscar por palavra no título ou no texto de apoio.
- Selecionar várias tarefas de uma vez para mover, concluir, mudar a prioridade ou descartar.
- Tarefas atrasadas, de hoje ou dos próximos dias ganham uma marca colorida na lateral; prioridade alta aparece em destaque.
- Ver a semana ou o mês no calendário e arrastar uma tarefa para outro dia.
- Desfazer a última alteração dentro de 24 horas, e conferir no histórico o que foi feito e quando.

**Conversar com o aplicativo**

- Escrever do seu jeito — “anota comprar pilhas”, “finalizei a #3”, “o que vence hoje?” — e deixar o assistente criar, mudar, concluir ou consultar.
- Mandar várias mensagens seguidas sem esperar: elas entram numa fila, aparecem como “Em espera” e são executadas uma de cada vez, na ordem.
- Tirar da fila uma mensagem que você mandou sem querer, antes de ela rodar.
- Quando algo dá errado, a fila para e você escolhe tentar de novo ou descartar aquele pedido e seguir.
- Ditar pelo microfone em vez de digitar, revisar o texto e só então enviar.
- Se o pedido estiver pela metade (“gastei no mercado”), o assistente pergunta o que falta antes de gravar.
- Você escolhe quais IAs o aplicativo usa e em que ordem, com limite diário para cada uma. Se uma falhar ou acabar a cota, ele passa para a próxima. Sem nenhuma IA cadastrada, ainda dá para usar frases em formato exato.

**Dinheiro**

- Registrar o que entrou e o que saiu, com valor, data, descrição e categoria.
- Usar as categorias que já vêm prontas (salário, alimentação, transporte, moradia, saúde, estudos, lazer, compras…) ou criar as suas, inclusive pela conversa.
- Ver no mês: quanto recebeu, quanto gastou e o que sobrou, além da comparação com o mês anterior.
- Ver quanto entrou em cada categoria e quanto saiu em cada categoria, lado a lado, e clicar numa delas para abrir os lançamentos.
- Acompanhar a evolução dia a dia e filtrar por mês, período, tipo ou categoria.
- Guardar modelos do que se repete (aluguel, salário, mensalidade) e lançar com um clique, escolhendo a data na hora.
- Corrigir, excluir e restaurar lançamentos; arquivar categorias que não usa mais sem perder o histórico.
- Falar com o assistente: “gastei 42,90 no almoço hoje”, “recebi 3 mil de salário ontem”, “quanto gastei com comida este mês?”.

**Anotações**

- Guardar textos soltos, sem prazo nem cobrança: cada um com um título e um espaço para escrever à vontade.
- Anexar arquivos à anotação (até 3 MB cada, 10 por anotação) e baixá-los depois.
- Procurar por qualquer palavra do título ou do texto.

**Avisos e uso no celular**

- Escolher, em cada tarefa, com quanta antecedência quer ser avisado. O aviso aparece enquanto o aplicativo estiver aberto; não há aviso com o aplicativo fechado.
- Instalar na tela de início do celular e usar como se fosse um aplicativo.
- Trabalhar sem internet nas tarefas: o que você criar ou mudar fica pendente e sobe sozinho quando a conexão voltar. Financeiro, anotações e assistente precisam de internet.

**Sua conta e seus dados**

- Entrar com senha, marcar o aparelho como confiável por 90 dias e ver a lista de dispositivos conectados, encerrando o acesso de qualquer um deles.
- Ligar a verificação em duas etapas por aplicativo autenticador, com códigos de recuperação para guardar.
- Baixar uma cópia de tudo (tarefas, grupos e finanças) e restaurar depois. As anotações e seus arquivos ainda não entram nessa cópia.
- Escolher tema claro ou escuro. Tudo em português, com datas no fuso da Bahia.

O nome que aparece na tela é **AgendaMagna**. O pacote, as tabelas e o campo de identificação do arquivo de backup seguem com o nome antigo, para não invalidar os backups já salvos.

## Testar localmente

Requisito: **Node.js 22.x**, com npm. Na primeira instalação é preciso internet para baixar as dependências.

```bash
./iniciar.sh
```

Abra **http://localhost:3000** e entre com a senha `PANEL_PASSWORD` do arquivo `.env`. Ela serve para o primeiro acesso. Depois do primeiro login, a senha fica armazenada como hash no banco e pode ser trocada em **Configurações → Segurança e dispositivos**; alterar o `.env` não substitui a senha já cadastrada. O script cria os segredos iniciais e, em um `.env` existente, acrescenta somente `LLM_ENCRYPTION_KEY` e `CRON_SECRET` quando ainda não estiverem definidos. Valores existentes, inclusive vazios, são preservados.

- O script instala dependências quando necessário.
- Os dados ficam em `.data/local`, preservados entre reinícios. O banco local é PGlite, um PostgreSQL embutido, sem Docker.
- Esse atalho **sempre usa o banco local**, mesmo se o `.env` tiver uma URL Neon. Ele não copia dados para o Neon.
- Use a conversa para criar e organizar tarefas; as alterações aparecem no mesmo painel.
- Encerre com `Ctrl+C`. Para outra porta: `./iniciar.sh 3002`.
- Use o endereço `localhost` mostrado pelo script: a proteção de origem verifica esse endereço.

Alternativa manual:

```bash
npm ci
npm run setup
npm run dev
```

Nesse caso, o banco e o endereço vêm do `.env`; o banco local padrão fica em `.data/agenda`.

## Publicar na Vercel com Neon

1. No Neon, crie um projeto para a agenda ou use o banco que já contém os dados dela. No painel de conexão, selecione **Pooled connection** e copie a URL completa, preservando os parâmetros SSL. O hostname da conexão agrupada contém `-pooler`. [Conexões no Neon](https://neon.com/blog/postgres-support-case-recap).
2. Importe o repositório na Vercel como projeto **Next.js**, com a raiz deste repositório e build `npm run build`. O projeto fixa Node.js `22.x`, versão disponível na Vercel. [Versões do Node.js](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
3. Em **Settings → Environment Variables**, cadastre as variáveis da tabela abaixo para **Production**. Use valores reais, sem os marcadores dos exemplos. `npm run setup` gera os segredos localmente para você copiar de forma privada.
4. Antes do deploy, aplique `npm run db:migrate` com a conexão administrativa e configure um usuário restrito no `DATABASE_URL` do aplicativo (veja **Permissões do banco** abaixo).
5. Confira a configuração antes de publicar. Escreva os valores de produção em `.env.production` — o `.gitignore` já ignora esse arquivo — e execute:

   ```bash
   npm run deploy:check
   ```

   A verificação não publica nada e não altera o banco. Ela lê o ambiente, confere formato e coerência das variáveis, conecta no banco, verifica se todas as tabelas do schema estão aplicadas, testa se a `LLM_ENCRYPTION_KEY` abre as chaves de IA já cadastradas e informa se a conexão do app ainda consegue criar ou apagar tabelas. `ERRO` impede o deploy; `AVISO` é endurecimento recomendado.

6. Faça o deploy. Se o domínio definitivo só aparecer depois do primeiro deploy, atualize `APP_URL` com esse endereço e faça um **Redeploy** para carregar a alteração.
7. Abra o endereço HTTPS, entre com sua senha e cadastre suas APIs de IA pelo painel. Acesse o mesmo endereço no notebook e no celular: ambos usam os mesmos dados do Neon.

| Variável              | Valor na Vercel                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_MODE`       | `postgres`                                                                                                                      |
| `DATABASE_URL`        | URL de conexão agrupada do Neon, com SSL, como `postgresql://USUARIO:SENHA@SEU_HOST-pooler.neon.tech/SEU_BANCO?sslmode=require` |
| `APP_URL`             | Origem exata do app, como `https://sua-agenda.vercel.app`; sem caminho ou barra final                                           |
| `PANEL_PASSWORD`      | Senha inicial para acessar o painel; dispensável se usar o hash abaixo                                                          |
| `PANEL_PASSWORD_HASH` | Alternativa preferida à linha acima, no formato `sal:hash`, gerada por `npm run senha:hash`                                     |
| `LLM_ENCRYPTION_KEY`  | Chave de 32 bytes: 64 caracteres hexadecimais ou base64; preserve-a entre deploys                                               |
| `CRON_SECRET`         | Segredo aleatório de pelo menos 32 caracteres que autentica a limpeza diária da lixeira                                         |

Prefira `PANEL_PASSWORD_HASH` no ambiente publicado: `npm run senha:hash` lê a senha pela entrada padrão, sem deixá-la no histórico do shell, e imprime a linha pronta para colar. Com o hash definido, remova `PANEL_PASSWORD` do projeto na Vercel — quem tiver acesso ao painel de variáveis não lerá sua senha. Trocar a senha é trocar essa variável e fazer um novo deploy.

Nenhuma dessas variáveis usa prefixo `NEXT_PUBLIC_`. As chaves dos provedores de IA são cadastradas no painel e armazenadas criptografadas no banco; não vão para o código nem para as variáveis de ambiente de cada provedor. `LLM_ENCRYPTION_KEY` é a chave do servidor que permite descriptografá-las. Ela também protege o segredo do autenticador. Se for perdida ou trocada, será necessário cadastrar novamente as chaves das APIs e recuperar o acesso de duas etapas com um código de recuperação.

Para usar **Preview**, configure também suas variáveis nesse ambiente. Use um banco ou branch Neon de testes e `APP_URL` com a origem exata daquele preview; não reutilize a origem de produção. Alterações de variáveis exigem novo deploy. As mutações só aceitam pedidos vindos de uma origem conhecida, o que barra requisições de outros sites. São aceitos o `APP_URL` e, quando publicado na Vercel, os endereços que a própria plataforma dá ao app: o domínio de produção, o do deployment e o da branch. Isso evita a recusa ao abrir justamente pelo link que o painel da Vercel entrega. Qualquer outro domínio — inclusive um domínio próprio — exige ajustar `APP_URL`, e a recusa passa a dizer quais endereços são aceitos.

No banco local, o schema é aplicado automaticamente a cada início. **Em PostgreSQL não é**: o app publicado nunca cria tabelas, a menos que `DATABASE_AUTO_MIGRATE=true`, o que não é recomendado. Sem a migração, o primeiro acesso falha já no login — ele grava sessão, limite de tentativas e configuração de segurança —, com a mensagem de que as tabelas ainda não existem. Migrações são separadas do aplicativo. Informe `DATABASE_MIGRATION_URL` com a conexão administrativa na máquina ou CI de migração e execute o comando abaixo. Essa variável tem precedência sobre `DATABASE_MODE`: um `.env` de desenvolvimento em modo local não desvia a migração para o banco embutido. O comando informa em qual banco o schema foi aplicado — host e nome, sem usuário nem senha —, então dá para conferir que foi no banco pretendido:

```bash
npm run db:migrate
```

Na Vercel, o banco local é bloqueado: configure o Neon antes de usar o app. O filesystem de uma função não serve como armazenamento persistente. Tarefas que você criou em `.data/local` não são transferidas automaticamente para um banco Neon novo.

A estrutura foi preparada para hospedagem na Vercel e no Neon, sujeita às cotas e condições das suas contas. A conexão e o deploy reais precisam ser validados nessas contas. Não é necessário contratar um domínio próprio.

O [vercel.json](vercel.json) habilita **Fluid Compute**. A API permite até 120 segundos por requisição para acomodar tentativas em vários provedores; esse tempo cabe no limite atual de 300 segundos do Hobby com Fluid Compute. [Configuração e limites do Fluid Compute](https://vercel.com/docs/fluid-compute).

## Cadastrar IA e alternar provedores

No menu **Modelos de IA**, clique em **Adicionar modelo** e cadastre um ou mais provedores com:

- Nome para identificação, tipo de API e modelo disponível na sua conta.
- Chave da API. Ao editar, deixe esse campo vazio para manter a chave já salva; ela não é retornada pelo servidor.
- URL completa do endpoint HTTPS público de `chat/completions`, quando usar uma API compatível. Use porta padrão 443, sem parâmetros, fragmentos ou credenciais na URL. O adaptador Gemini usa a API nativa.
- Prioridade: os menores números são tentados primeiro.
- Limites diários de requisições e tokens, além da opção de ativar ou desativar o provedor. No limite de tokens, `0` significa sem limite local.

Você pode adicionar até 20 modelos, do mesmo serviço ou de serviços diferentes. O cadastro fica salvo no banco, sem alteração de código ou novo deploy. A interface mostra uso do dia, falhas e pausa temporária de cada provedor. A API compatível precisa aceitar autenticação Bearer e os campos `model`, `messages`, `max_tokens`, `temperature` e `response_format` com `json_object`.

Modelos de raciocínio costumam recusar `response_format` com `json_object`, porque o texto sai do passo de raciocínio e a API não garante o formato. Quando uma API compatível recusa o pedido com HTTP 400, a mesma API é chamada outra vez sem esse campo, já que o prompt exige JSON e o leitor aceita texto em volta do objeto. As duas chamadas contam no uso do dia; se a segunda funcionar, o provedor não é pausado. Nos modelos Gemini 2.5 Flash o raciocínio é desligado no pedido: ele consumia o mesmo orçamento de saída e o tempo de espera, e a resposta voltava vazia ou estourava o tempo.

O tipo escolhido decide com quem a agenda fala. `Gemini` fala sempre com a API do Google e por isso não tem campo de endereço: serve só para modelos do Google. Um modelo de outro serviço com esse tipo faz a agenda pedir aquele modelo ao Google, que recusa — a tela de modelos passa a apontar essa troca. Para Groq, OpenAI, OpenRouter e semelhantes, use `Compatível com Chat Completions` e informe a URL.

O campo de URL espera o endpoint inteiro, não o endereço base que a maioria das documentações divulga. Em serviços compatíveis, some `/chat/completions` ao final: o Groq, por exemplo, documenta `https://api.groq.com/openai/v1` e aqui se informa `https://api.groq.com/openai/v1/chat/completions`. O endereço do site ou do painel do serviço também não serve: ele responde com um redirecionamento, que a agenda não segue para o destino não escapar da verificação de endereço público, ou devolve HTML em vez de JSON. Os dois casos são nomeados na tela de modelos. Só o endereço base responde HTTP 404, e a tela mostra isso junto com o código estruturado devolvido pela API (`unknown_url`, `model_not_found`, `PERMISSION_DENIED`). O texto da mensagem do provedor nunca é exibido: ele pode repetir o que você escreveu. Se o código apontar o modelo, confirme que aquele identificador aceita resposta em JSON — nem todos os modelos de um mesmo serviço aceitam.

O fluxo é:

1. Toda mensagem vai para a IA: usa o primeiro provedor habilitado, com orçamento disponível e fora da pausa temporária. Isso inclui pedidos simples como “ajuda”, que também consomem cota.
2. Em caso de cota esgotada, erros HTTP `429`/`402` ou falha transitória, o sistema pausa esse provedor e tenta o próximo na mesma mensagem.
3. Cada mensagem tenta no máximo quatro provedores, com orçamento de 85 segundos para as tentativas de IA. Provedores restantes podem ser usados nas próximas mensagens. Se nenhum estiver disponível, a conversa informa o motivo de cada modelo (limite local, erro da API ou pausa) e o tempo restante; nenhuma ação parcial é aplicada. Havendo IA cadastrada, o modo reserva não assume nesse caso: o pedido termina em erro e as alterações podem ser feitas pelo painel.

Se uma IA responder com comandos em formato inválido, o pedido termina sem alterações e pede reformulação; nesse caso não é tentada outra interpretação automaticamente.

Os limites diários usam o fuso `America/Bahia`. O painel separa tokens confirmados nos metadados da API, estimativas de respostas sem contagem e registros antigos sem detalhamento. Falhas de conexão ou timeout não somam tokens: entram como tentativas sem confirmação de consumo, pois o provedor ainda pode ter processado o pedido. O limite de chamadas conta as tentativas, inclusive as que falham. Estimativas e registros antigos entram no controle local de tokens, mas não representam o saldo ou a cobrança real do provedor. O limite é verificado antes da chamada, mas uma chamada ainda pode ultrapassar o saldo configurado. **Liberar tentativa** retira a pausa de um provedor sem zerar seu uso diário. O tempo de espera por API é de até 45 segundos, dentro do orçamento total de 85 segundos. Erros HTTP 429 respeitam `Retry-After` ou `RetryInfo` do Gemini; sem orientação do provedor, a pausa é de 60 segundos. Um 429 pode indicar requisições por minuto ou por dia, mesmo quando ainda há tokens disponíveis. [Limites do Gemini](https://ai.google.dev/gemini-api/docs/rate-limits).

Não existe uma consulta universal ao saldo real de todas as APIs. A troca automática depende dos limites cadastrados, do consumo observado e dos erros devolvidos pelo serviço. APIs ou modelos que compartilham a mesma cota podem ficar indisponíveis juntos. Um limite dentro da agenda não transforma uma API paga em gratuita: confira o plano e os controles de cobrança de cada provedor.

## Lixeira e agendamento

A exclusão de itens com retenção vencida acontece durante o uso da aplicação e também pode rodar sem ninguém abrir o app: [vercel.json](vercel.json) agenda `GET /api/cron/cleanup` diariamente com `0 6 * * *`, às 06:00 UTC (03:00 em `America/Bahia`).

Esse cron é compatível com a frequência diária do plano Hobby, que não garante execução no minuto exato. Ele faz manutenção da lixeira, não envio de lembretes. [Limites do cron da Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Defina `CRON_SECRET` em produção: a Vercel envia automaticamente `Authorization: Bearer SEU_SEGREDO`, que a rota valida. Sem esse segredo, a rota não aceita chamadas; a limpeza durante o uso continua funcionando. No painel da Vercel, confira os logs e a execução em **Cron Jobs** depois do deploy. [Proteção do cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## O que está implementado

- Grupos: criar, renomear, personalizar cor/ícone/ordem, arquivar/restaurar e excluir. A exclusão oferece preservar tarefas (ativas na Caixa de entrada) ou enviá-las à lixeira. Tarefas já descartadas mantêm seu prazo. Caixa de entrada não é um grupo excluível.
- Tarefas: título, descrição, prioridade, situação, data/horário, etiquetas, checklist, recorrência e antecedência do lembrete. Recorrência diária, semanal (dias escolhidos) ou mensal cria a próxima ocorrência ao concluir, preservando a anterior.
- Filtros: hoje, atrasadas, sem prazo, concluídas e lixeira; busca por título/descrição e paginação.
- Concluir preserva no histórico de concluídas, fora da lixeira. Descartar envia à lixeira sem marcar conclusão. Restaurar/reabrir retorna a pendente. A migração recupera concluídas antigas que ainda não foram apagadas; não recupera dados já excluídos definitivamente.
- Retenção configurável, inicialmente 30 dias. A mudança vale para novas entradas; repetir a conclusão não reinicia o prazo.
- Histórico e desfazer por 24 horas, com detecção de conflito entre painel e conversa. Criar uma lista pode ser desfeito como conjunto. Alterações de grupos também têm desfazer, incluindo tarefas movidas na exclusão; configurações e importação não têm desfazer.
- Até dez ações por mensagem de IA e cem ações por lote do painel, aplicadas atomicamente. A seleção em lote permite mover, concluir, restaurar, alterar prioridade ou descartar tarefas. Ambiguidades pedem esclarecimento, sem gravar partes do pedido.
- Referências recentes por conversa por 30 minutos, seleção de tarefas homônimas e continuação por “mostrar mais”.
- Login com cookie HttpOnly/SameSite, token aleatório armazenado somente como hash no servidor, verificação de origem e limite de tentativas. Sessão comum de 12 horas ou dispositivo confiável por 90 dias. Logout/revogação invalidam o acesso no servidor.
- Calendário semanal/mensal, com reagendamento ao arrastar uma tarefa e edição de data nos detalhes. Atualização automática a cada 15 segundos enquanto a página está visível, além do retorno à aba e reconexão.
- Manifesto, ícones e service worker para instalar o webapp e habilitar o modo offline opcional. Notificações de lembretes enquanto a agenda está aberta; não há envio push com o aplicativo fechado.
- Exportação e restauração de tarefas/grupos/configuração de retenção em JSON. O arquivo não inclui senhas, segredos de duas etapas nem chaves de IA.
- Consultas no assistente por data exata ou intervalo; respostas com resumo, identificadores, títulos e prazos em linhas separadas. “Dia 24 do mês que vem” e nomes de mês são resolvidos pelo modelo, com a tabela de meses já calculada no contexto; o atalho fixo de data só age quando a mensagem cita um dia do mês corrente.
- Conversa com o assistente como tela inicial do painel, em tela cheia: é o que abre ao entrar, e a lista de tarefas fica a um clique na navegação lateral.
- Pedidos fora do catálogo de operações recebem “Não consigo fazer isso ainda.” com o motivo, em vez de uma pergunta que não levaria a lugar nenhum.
- Reescrita opcional das respostas em linguagem natural por uma segunda chamada à IA, com conferência de identificadores, datas e linhas de tarefas antes de aceitar o texto.
- Destaque na lista por urgência e prioridade: barra colorida à esquerda para atrasadas, para hoje e para os próximos três dias, com o prazo em negrito, e prioridade alta com título e etiqueta reforçados. Nunca é só cor — o peso do texto muda junto.
- Anotações soltas com título, texto longo, busca e arquivos anexados no banco.
- Modelos de lançamento no financeiro, para repetir com um clique o que é fixo todo mês.

Áudio, contas para vários usuários e envio de notificações com o app fechado continuam fora desta versão; pedidos assim são recusados com “Não consigo fazer isso ainda.”. Não foram adicionados controle de contexto privado da IA, prévia das ações da IA ou histórico detalhado de consumo por chamada.

## Modo reserva: quando não há IA cadastrada

```text
Crie um grupo chamado Estudos
Adicione ler capítulo 3 em Estudos
Em Estudos, adicione fazer lista 1, revisar limites e resolver exercícios
Anota: comprar pilhas
Quais tarefas existem?
Quais tarefas existem em Estudos?
Acrescente na descrição de #1: resolver somente questões pares
Troque a descrição de #1 por: resolver questões 2 e 4
Comecei #1
Coloque prioridade alta em #1
#1 é para amanhã
Deixe #1 sem prazo
Finalizei #1
Restaure #1
Mova #1 para Estudos
Tire #1 do grupo
Exclua #1
Mostre a lixeira
O que vence hoje?
O que está atrasado?
Busque capítulo
Exclua as tarefas da lixeira depois de 15 dias
Qual é o prazo da lixeira?
Desfaça a última alteração
Ajuda
```

Essas frases valem apenas enquanto nenhum provedor de IA estiver ativo, e só neste formato exato. Com uma IA cadastrada, ela interpreta todas as mensagens e você escreve do seu jeito, como em “adicione em InfoJr a proposta até quinta”. Quando houver tarefas homônimas, responda com o número da opção. Para um grupo inexistente, “criar” confirma a criação e retoma o pedido. Excluir um grupo sem dizer o que fazer com as tarefas dele abre a mesma pergunta, com as duas opções reais: mantê-las na Caixa de entrada ou enviá-las à lixeira junto. Toda pergunta dessas aceita resposta em palavras — “manter”, “excluídas”, “na lixeira” — além do número, e o pedido original é retomado com a escolha; ele fica reservado por 30 minutos. Uma resposta que serve às duas opções, como “excluir o grupo mas manter as tarefas”, não é tratada como escolha: a agenda pergunta de novo. Um novo comando claro substitui a pergunta pendente.

## Atualizar a instalação anterior

Execute `npm run setup` para acrescentar os novos segredos ausentes ao `.env`. Na Vercel, cadastre-os também nas variáveis do projeto. Mantenha a mesma conexão com o banco para preservar tarefas, grupos e histórico. Execute a migração antes de publicar esta versão. Ela acrescenta tabelas de credenciais e sessões, além de preservar as concluídas fora da lixeira. As sessões antigas exigirão um novo login uma vez. A variável legada `SESSION_SECRET` não é mais utilizada.

Cadastre os provedores de IA novamente no painel; variáveis de ambiente antigas para configurar IA não têm mais efeito. Remova do projeto na Vercel qualquer variável de ambiente que não apareça na tabela acima — nenhuma delas é necessária nesta versão.

## Docker local opcional

```bash
npm run setup
docker compose up --build -d app
```

Abra `http://localhost:3000`. Há somente o serviço `app`; o volume `app_data` preserva o banco local. Se o `.env` tiver `DATABASE_MODE=postgres`, o app usa o banco indicado em `DATABASE_URL`. A Vercel não usa esse Compose nem exige Docker.

## Estrutura e verificações

O projeto é um único deploy na Vercel, mas o código é dividido em duas pastas por responsabilidade. `src/app/` fica pequeno de propósito: é só a casca que o Next.js exige (páginas e o roteador da API), que imediatamente chama o front-end ou o backend.

```text
iniciar.sh                    Início rápido para testar localmente
src/app/                      Casca do Next.js — só liga tudo abaixo, sem regra de negócio
  api/[...path]/route.ts        Roteador único da API (autenticação, origem, despacho)
  page.tsx, layout.tsx          Página e layout
  manifest.ts                   Manifesto PWA (ícone e instalação)

src/frontend/                 Interface — tudo o que roda no navegador
  dashboard/                    Painel: tela principal e cada diálogo em seu próprio arquivo
  llm-settings.tsx              Cadastro de provedores de IA no painel

src/backend/                  Regras, dados e integrações — nada de JSX aqui
  finance/                      Regras financeiras, valores em centavos e consultas paginadas
  domain/                       Regras puras: tipos, comandos, busca de tarefas/grupos, lixeira
    types.ts                      Tipos de estado e o schema dos comandos
    format.ts                     Data, fuso e rótulos
    lookup.ts                     Resolução de referências ("essa tarefa", "#3", nome de grupo)
    execute.ts                    Executor de comandos (cria, edita, desfaz…)
    purge.ts                      Exclusão definitiva após a retenção
  llm/                          Integração com IA, por responsabilidade
    ssrf.ts                        Só hosts HTTPS públicos; DNS preso ao socket da requisição
    crypto.ts                      Criptografia AES-256-GCM das chaves salvas
    providers.ts                   Cadastro de provedores (listar/salvar/excluir/reativar)
    usage.ts                       Limite diário por provedor e pausa após erro
    generate.ts                    Laço de troca: tenta os provedores em ordem de prioridade
  db.ts                         PostgreSQL/Neon e PGlite
  schema.ts                     Schema idempotente
  interpreter.ts                Interpretação com IA e o modo reserva sem IA
  service.ts                    Execução de ações e limpeza

vercel.json                   Limpeza diária em produção
tests/                        Testes de regras, integração e navegador
```

O front-end só fala com o backend por `fetch('/api/...')`; nunca importa nada de `src/backend/` em tempo de execução (somente tipos compartilhados), e o navegador nunca vê chave de banco ou de IA.

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

Os testes de integração usam PostgreSQL embutido em memória. Os testes de navegador usam banco temporário separado dos seus dados e constroem/servem a versão de produção, necessária para testar recarregamento offline sem a conexão de desenvolvimento do Next.js. `PLAYWRIGHT_DEV=1` usa o servidor de desenvolvimento, sem garantir o teste de recarregamento offline. Para usar um Chromium já instalado, informe `PLAYWRIGHT_CHROMIUM_EXECUTABLE` com seu caminho. Testes com respostas simuladas de IA não comprovam qualidade de compreensão de um modelo nem disponibilidade ou saldo de uma API real.

Backups: com o servidor local **parado**, copie `.data/local` para um local seguro. No Neon, mantenha backups PostgreSQL (`pg_dump`/`pg_restore`) conforme sua necessidade. Guarde também os segredos do ambiente, especialmente `LLM_ENCRYPTION_KEY`, em local protegido; ela é necessária para recuperar as chaves das APIs guardadas no banco. Backups têm retenção própria. A restauração deve ser validada no ambiente escolhido.

## Segurança e dispositivos

Em **Configurações → Segurança e dispositivos**, confirme sua senha para alterá-la, configurar/desativar duas etapas ou encerrar sessões. Com duas etapas ativas, essas operações também exigem o código do autenticador ou um código de recuperação. Trocar a senha ou ativar/desativar duas etapas encerra os outros dispositivos.

Para ativar, copie a chave exibida para um aplicativo autenticador compatível com TOTP (conta baseada em tempo, seis dígitos) e confirme um código. Guarde os dez códigos de recuperação: cada um funciona uma vez e eles não serão exibidos novamente. O segredo TOTP é criptografado com a chave do servidor, e os códigos de recuperação são armazenados somente como hashes. Referência do algoritmo: [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238).

No login, marque **Confiar neste dispositivo por 90 dias** apenas em aparelho pessoal. Isso mantém a sessão mesmo fechando o navegador, sem pedir senha e código a cada abertura. O navegador pode remover cookies antes do prazo. Ao expirar, sair ou revogar a sessão, será necessário entrar novamente. Sem essa opção, a sessão dura 12 horas. Uma sessão revogada é recusada na próxima requisição; os dados visíveis são retirados na próxima atualização da tela.

## Offline e lembretes

Ative **Permitir acesso offline neste dispositivo** nas configurações enquanto conectado. O app guarda uma cópia pessoal em IndexedDB e arquivos da interface no cache; não guarda a senha nem chaves de IA. A cópia tem a mesma validade máxima da sessão, é removida ao sair/receber uma recusa de autenticação e pode ser apagada desativando a opção. Proteja o aparelho com bloqueio de tela: a cópia offline é legível para quem tem acesso ao perfil do navegador. Uma revogação feita em outro aparelho só pode ser detectada quando este voltar à internet.

É possível criar, editar, concluir, descartar e restaurar tarefas offline. As mudanças ficam identificadas como pendentes, sobrevivem a recarregamentos e são enviadas na ordem quando o app volta à conexão. IDs de requisição evitam execução duplicada após falhas de rede. Alterações concorrentes geram conflito, interrompem a fila e oferecem descartar as pendências e refazer a edição com os dados atuais. Tarefas criadas offline ficam editáveis após sincronizar. Gerenciamento de grupos, importação, segurança, financeiro e execução do assistente exigem internet. O cache offline guarda tarefas e grupos; conversas e histórico financeiro ficam fora dele. Abra e recarregue o app conectado uma vez para preparar os arquivos de navegação offline. Para testar isso localmente, use `npm run build` e `npm start`; o servidor de desenvolvimento depende de conexão para inicializar sua interface.

Em cada tarefa, escolha a antecedência do lembrete. Nas configurações, ative notificações e aceite a permissão do navegador. Os avisos usam o título da tarefa; sem horário, consideram 09:00 em `America/Bahia`. São verificados a cada 30 segundos enquanto o app está aberto, inclusive avisos atrasados em até 24 horas; grupos arquivados e tarefas concluídas/descartadas não notificam. Abas em segundo plano podem sofrer atrasos do navegador. Não há envio com o app fechado. [Limites e funcionamento das notificações](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API).

## Exportação e restauração

Use **Configurações → Exportar e restaurar**. Antes de restaurar, baixe uma cópia da agenda atual. O backup exportado é versão 2 e inclui categorias e lançamentos financeiros, inclusive excluídos. O painel mostra a contagem de grupos e tarefas e exige confirmação e senha (e duas etapas, se ativa). O servidor valida o formato, limites, referências e a revisão da agenda; uma edição concorrente interrompe a restauração. Importar substitui tarefas, grupos e retenção e limpa histórico de ações/conversa. Na versão 2, a prévia também informa a substituição de todas as categorias e lançamentos financeiros. Arquivos da versão 1 continuam aceitos e preservam o financeiro existente. Credenciais, modelos e sessões não são importados. O limite do arquivo é 2 MB, até 10 mil tarefas, mil grupos, 10 mil lançamentos e mil categorias. O backup PostgreSQL continua sendo necessário para recuperar todos os dados administrativos e as chaves criptografadas.

## Permissões do banco

Na Vercel, o limite de tentativas considera o IP informado pela plataforma, usando `x-vercel-forwarded-for`; em execução local os acessos compartilham o limite. [Cabeçalhos de requisição da Vercel](https://vercel.com/docs/headers/request-headers).

A conexão de execução deve ter somente `SELECT`, `INSERT`, `UPDATE` e `DELETE` nas tabelas da aplicação, além de `USAGE` no schema. Ela não deve ser dona das tabelas/banco, ter privilégios administrativos ou permissão `CREATE` no schema. O aplicativo não executa DDL automaticamente em PostgreSQL; `DATABASE_AUTO_MIGRATE=true` existe apenas como opção explícita de compatibilidade, sem separação de privilégios.

1. Em uma máquina/CI administrativa, defina `DATABASE_MIGRATION_URL` e execute `npm run db:migrate`. Ela prevalece sobre `DATABASE_MODE`; sem ela, e fora do modo local, o script utiliza `DATABASE_URL`.
2. Execute [scripts/runtime-role.sql](scripts/runtime-role.sql) com a conexão administrativa para criar o grupo de permissões `agenda_runtime` (uma vez).
3. Crie um login dedicado sem permissões administrativas e conceda a ele `agenda_runtime`. Não use como login da aplicação um proprietário ou uma conta que herde permissões administrativas.
4. Configure somente a URL restrita em `DATABASE_URL` na Vercel. A credencial de migração deve ficar fora do ambiente do aplicativo. Mantenha `DATABASE_AUTO_MIGRATE=false`.
5. Verifique as permissões efetivas do login: operações normais devem funcionar e `CREATE TABLE`/`DROP TABLE` devem ser recusadas. Se o schema conceder `CREATE` a `PUBLIC`, corrija isso administrativamente ou use um schema isolado antes de considerar o login restrito.

As consultas usam parâmetros para valores e uma lista fixa de tabelas para identificadores. Os testes permanentes incluem SQL injection pelo login e campos de tarefas, rejeição de comandos arbitrários, origem inválida, cookies adulterados, revogação, TOTP e uma conexão com papel restrito que não pode criar/apagar tabelas. Isso valida esses cenários, sem substituir revisão contínua de segurança.

## Como o assistente responde

A mensagem é aceita em duas etapas. A primeira grava o texto e reserva o pedido, e é ela que responde à requisição — em menos de um segundo, antes de qualquer chamada à IA. A segunda interpreta e executa, depois da resposta. Você pode fechar a aba, trocar de tela ou perder a conexão: o pedido termina no servidor, e a resposta aparece na conversa quando você voltar. Enquanto um pedido está em andamento, a tela consulta a cada segundo. O campo continua disponível: novos envios aparecem como “Em espera” e são executados um por vez, na ordem de envio, após a conclusão anterior. Você pode remover itens ainda em espera. Em falhas, a fila pausa e permite tentar novamente com o mesmo identificador ou descartar o item e continuar. Perguntas de esclarecimento pausam a fila: a resposta digitada tem prioridade sobre os itens pendentes. A fila existe apenas na tela atual; sair ou recarregar descarta os itens ainda não enviados, com aviso. O pedido já aceito continua no servidor. Se o servidor for interrompido no meio, a reserva vence em 150 segundos e a mensagem é marcada como interrompida, para reenvio.

Mensagem → contexto limitado + LLM → comandos JSON → validação e execução pelo servidor → resposta montada a partir do que aconteceu → segunda chamada opcional que reescreve essa resposta → texto na tela. O provedor não recebe credenciais de banco e não executa SQL: ele devolve comandos, e quem consulta e altera os dados é o servidor, depois de validar cada campo. Falhas de provedor podem causar tentativas em outras APIs conforme a ordem configurada. Respostas de esclarecimento e “mostrar mais” podem ser resolvidas diretamente quando já existe uma pergunta/lista pendente.

A segunda chamada é só redação. Ela recebe a resposta já pronta — não a agenda — e devolve o mesmo conteúdo em linguagem natural. Antes de ser aceita, a versão reescrita é conferida: cada linha de tarefa (`#7 proposta — 24/09/2026`) e cada opção numerada precisa aparecer igual, na mesma ordem, sem nenhuma a mais ou a menos, e o texto não pode crescer além do dobro do original. Se a conferência falhar, se o modelo não responder ou se não houver modelo disponível, vale a resposta original — uma alteração já gravada nunca se perde por causa do acabamento do texto. Recusas começadas por “Não consigo fazer isso ainda.” e respostas de operações financeiras não passam por essa chamada; confirmações financeiras usam diretamente os dados gravados e totais calculados pelo servidor. O custo é uma chamada a mais por mensagem, contada nos limites diários, e a resposta pronta (títulos e prazos das tarefas envolvidas) é enviada ao provedor. Desligue em Configurações → Respostas do assistente se preferir o formato direto.

Pedidos que a agenda não sabe atender — enviar e-mail, compartilhar com outra pessoa, arquivos de áudio, anexos, integração bancária, investimentos, reorganização automática — recebem “Não consigo fazer isso ainda.”, seguido de uma frase sobre o que falta. Pedido ambíguo é diferente: aí a resposta é uma pergunta, porque a operação existe e só falta escolher a tarefa, o grupo ou a data.

## Ditado e descrição de tarefas

No assistente, use **Ditar mensagem**, fale em português e pare para revisar o texto antes de enviar. O rascunho digitado é preservado, e **Cancelar ditado** o restaura. A escuta termina em até 60 segundos; textos acima de 6.000 caracteres precisam ser reduzidos antes do envio. É possível ditar a próxima mensagem enquanto outra está sendo executada.

O recurso depende de `SpeechRecognition`/`webkitSpeechRecognition`. O navegador pode enviar áudio ao serviço de reconhecimento; o app não armazena áudio nem recebe arquivos de voz. Se o recurso ou o microfone não estiver disponível, continue digitando. Compatibilidade e qualidade do microfone precisam ser conferidas no aparelho usado; os testes automatizados simulam eventos. Referências: [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) e [Web Speech API](https://webaudio.github.io/web-speech-api/).

A prévia de descrição das tarefas aparece também no celular. Toque no item para ler ou editar o texto completo, com quebras de linha e limite de 5.000 caracteres. Tarefas na lixeira mantêm a leitura; restaure antes de editar.

## Financeiro

Abra **Financeiro → Novo lançamento** para registrar receitas ou despesas recebidas/gastas. Valores são em BRL, no formato `1.234,56`, entre R$ 0,01 e R$ 999.999.999,99, armazenados em centavos inteiros. Datas são civis, com referência de hoje em `America/Bahia`. Cadastre, renomeie, arquive ou reative categorias em **Gerenciar categorias**. Arquivar preserva os vínculos antigos; uma categoria com lançamentos não pode mudar para um tipo incompatível.

O resumo mostra receitas, despesas e resultado mensal (receitas menos despesas), o que entrou e o que saiu em cada categoria — em duas listas separadas, para que uma receita não esconda um gasto da mesma categoria — e a evolução diária. Mês e ano são escolhidos em listas, e não em `input type="month"`, porque o Firefox não desenha o seletor desse campo. Selecione também intervalo, tipo ou categoria; clicar em uma categoria filtra os lançamentos por ela e pelo tipo correspondente. A lista tem páginas de 20 itens, e os totais consideram todo o período filtrado. Excluídos não entram nos gráficos e podem ser restaurados em **Ver excluídos**. A comparação usa o mês anterior ao início do período selecionado e os mesmos filtros de tipo/categoria.

Em **Modelos de lançamento**, guarde o que se repete todo mês (aluguel, salário, mensalidade) com tipo, valor, descrição e categoria. **Lançar** abre o formulário já preenchido para você escolher a data e confirmar: o modelo não gera lançamento sozinho, não tem data e continua salvo depois de usado. Excluir um modelo não mexe nos lançamentos já feitos.

Com uma IA cadastrada, envie “Gastei 42,90 no almoço hoje”, “Recebi 3 mil de salário ontem” ou “Quanto gastei com comida este mês?”. O interpretador sugere uma categoria existente na mesma chamada; você pode corrigi-la no painel. Peça “crie a categoria besteiras” para cadastrar uma categoria pela conversa — sem o tipo dito, ela nasce como categoria de despesa, e a resposta diz isso. Modelos de lançamento são só do painel. Se faltar valor ou identificação, o assistente pergunta antes de gravar. Exclusões pela conversa exigem confirmação. Pedidos com tarefas e finanças são atômicos. O histórico registra as mudanças, mas o desfazer global não reverte finanças; faça a correção ou restauração pela tela financeira.

O financeiro exige conexão. O cadastro manual continua disponível quando a IA está sem cota. Não há sincronização bancária, cartões/faturas, parcelas, investimentos, múltiplas moedas ou aprendizado automático de categorias.

## Anotações

**Anotações** guarda texto solto: um título, um espaço de até 20.000 caracteres e arquivos anexados. A busca procura no título e no texto, e a lista tem páginas de 20 anotações, da mais recente para a mais antiga.

Cada anexo pode ter até 3 MB e cada anotação aceita até 10 arquivos. O limite acompanha o teto de 4,5 MB que a Vercel aplica ao corpo de uma requisição, já contando o crescimento do base64. Os arquivos ficam no próprio banco, em base64, e são enviados e baixados pelas rotas `notes/file`; a lista de anotações nunca carrega o conteúdo deles. Excluir uma anotação apaga os arquivos junto, e a confirmação avisa. Salvar confere a versão: se a anotação mudou em outro aparelho, o salvamento é recusado em vez de sobrescrever.

Anotações exigem conexão e **não entram no arquivo de exportação**. Restaurar um backup não apaga nem devolve anotações — elas ficam intocadas. Para não perdê-las, conte com o backup do PostgreSQL.

### Migração desta entrega

Execute `npm run db:migrate` com a conexão administrativa antes de publicar. A migração acrescenta `agenda_finance_categories`, `agenda_finance_entries`, `agenda_finance_templates`, `agenda_notes` e `agenda_note_files`, seus índices e dez categorias iniciais, sem apagar tarefas nem duplicar categorias em execuções posteriores. Bancos locais aplicam a migração na inicialização.

A migração também concede leitura e escrita nas tabelas ao papel `agenda_runtime`, se ele já existir. A criação do papel em `scripts/runtime-role.sql` é necessária apenas na primeira instalação.

`npm run deploy:check` confere a presença das tabelas e os privilégios de leitura/escrita. Valide migração e permissões no PostgreSQL de homologação antes da publicação. Os testes locais usam PGlite e bancos temporários, sem modificar os dados reais.

### Criar as tabelas das novas funcionalidades

A migração cobre financeiro, modelos de lançamentos, anotações e anexos. Com a conexão administrativa configurada em `DATABASE_MIGRATION_URL`, execute `npm run db:migrate`. O comando preserva os dados existentes e atualiza os privilégios do papel `agenda_runtime`, se ele já existir.

Se preferir o editor SQL do provedor, execute o conteúdo completo de [scripts/migrate.sql](scripts/migrate.sql). O arquivo pode ser aplicado mais de uma vez. Para regenerá-lo a partir do schema atual, use `npm run --silent db:sql > scripts/migrate.sql`. Nunca use a conexão administrativa como credencial de execução do aplicativo.

Em modo local, as migrações novas são aplicadas automaticamente também após atualização do código com a conexão ainda aberta. No PostgreSQL publicado, a migração continua explícita, pois o papel de execução não deve ter permissão para criar tabelas.

A frase “adicione em Pessoal mandar email sobre horas optativas ate hj” cria uma tarefa em Pessoal, com prazo no dia da mensagem em `America/Bahia`. “Mandar email” é o título da tarefa; o aplicativo não envia o email. Se Pessoal ainda não existir, a conversa oferece criá-lo antes de concluir o pedido.
