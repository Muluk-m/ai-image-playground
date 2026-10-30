package main

import (
	"os"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/cli"
)

func main() {
	app := cli.New(cli.ParseBaseURL(), cli.ParseStore(), os.Stdout, os.Stderr)
	os.Exit(app.Run(os.Args[1:]))
}
