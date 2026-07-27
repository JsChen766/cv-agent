package email

import (
	"context"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// SMTPSender delivers local OTP messages to Mailpit over plain SMTP.
type SMTPSender struct {
	address string
	from    string
	name    string
}

func NewSMTPSender(address, from, name string) *SMTPSender {
	return &SMTPSender{address: address, from: from, name: name}
}

func (s *SMTPSender) SendLoginCode(
	ctx context.Context, recipient, code string, expiresIn time.Duration,
) error {
	dialer := net.Dialer{Timeout: 5 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", s.address)
	if err != nil {
		return err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	host, _, err := net.SplitHostPort(s.address)
	if err != nil {
		return err
	}
	client, err := smtp.NewClient(connection, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Mail(s.from); err != nil {
		return err
	}
	if err := client.Rcpt(recipient); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	minutes := int(expiresIn.Round(time.Minute) / time.Minute)
	body := fmt.Sprintf(
		"From: %s <%s>\r\nTo: <%s>\r\nSubject: Coolto login code: %s\r\n"+
			"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n"+
			"Your Coolto login code is: %s\r\n\r\nIt expires in %d minutes.\r\n",
		safeHeader(s.name), s.from, recipient, code, code, minutes,
	)
	if _, err := writer.Write([]byte(body)); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func safeHeader(value string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(value)
}
