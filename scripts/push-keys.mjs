// Gera o par de chaves VAPID dos lembretes com o app fechado e imprime as linhas prontas para
// colar no .env e nas variáveis da Vercel. Trocar as chaves depois invalida as inscrições já
// feitas: cada aparelho precisa desativar e ativar os lembretes de novo.
//
//   npm run push:keys
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:seu-email@exemplo.com');
process.stderr.write(
  '\nTroque o e-mail de VAPID_SUBJECT por um seu: o serviço de push usa esse contato se houver problema.\n',
);
